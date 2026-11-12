import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import { systemAudit, type SystemActor } from "./audit";
import { DEVICE_TRANSITIONS, deviceAuditResource, isUuid, type SystemDeviceStatus } from "./kiosks";

/**
 * Per-device kiosk ingest authentication (HMAC-SHA256).
 *
 * Credential model:
 *  - `issueDeviceCredential` generates a 32-byte random secret, returns it ONCE,
 *    and persists ONLY `device_secret_hash = sha256(secret)` plus issued/expiry
 *    timestamps. The raw secret is never stored, logged, or audited.
 *  - The device uses `signingKey = hex(sha256(secret))` — i.e. the SAME value the
 *    server stores — as the HMAC-SHA256 key over `${timestamp}.${rawBody}`.
 *    (SHA-256 of a 256-bit random secret is itself a fine HMAC key; storing it
 *    lets the server verify signatures without ever holding the raw secret.)
 *    Use `deviceSigningKey(secret)` / `signDeviceRequest(...)` helpers — do not
 *    hand-roll.
 *  - Requests carry `X-Device-Id` (device_uid or uuid), `X-Device-Timestamp`
 *    (unix seconds or ms, ±5 min window) and `X-Device-Signature` (hex HMAC).
 *  - Replay protection: `last_message_ts` (ms) must strictly increase per device.
 *  - Every attempt — ok or rejected — writes a `system_device_messages` row with
 *    auth_method + result + a short reason. Secrets and signatures are NEVER
 *    recorded.
 *
 * Legacy migration path: the shared `KIOSK_INGEST_SECRET` bearer is still
 * accepted by /api/devices/events ONLY while `KIOSK_LEGACY_INGEST=1` is set AND
 * the resolved device has no live hmac credential (auth_method
 * 'shared_secret_legacy', 'pending', 'none', or no system_devices row at all).
 * Flip devices to 'hmac_sha256' via the credential endpoints, then unset the
 * flag to retire shared-secret ingest.
 */

export const DEVICE_CREDENTIAL_TTL_MS = 365 * 24 * 3600_000; // 1 year
export const DEVICE_AUTH_WINDOW_MS = 5 * 60_000; // ±5 minutes
const DEVICE_AUTH_RATE = { limit: 60, windowMs: 60_000 };

export const DEVICE_AUTH_METHODS = ["pending", "hmac_sha256", "shared_secret_legacy", "none"] as const;
export type DeviceAuthMethod = (typeof DEVICE_AUTH_METHODS)[number];

/** Columns device-auth needs — a subset of system_devices. */
export type DeviceAuthRow = {
  id: string;
  device_uid: string | null;
  serial_number: string | null;
  status: SystemDeviceStatus | string;
  auth_method: DeviceAuthMethod | string | null;
  device_secret_hash: string | null;
  credential_issued_at: string | null;
  credential_expires_at: string | null;
  credential_revoked_at: string | null;
  last_authed_at: string | null;
  last_message_ts: number | string | null;
};

const AUTH_SELECT =
  "id,device_uid,serial_number,status,auth_method,device_secret_hash,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts";

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmacHex = (key: string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest("hex");
const safeEqHex = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The value stored in device_secret_hash AND used as the HMAC key. */
export const deviceSecretHash = (secret: string) => sha256hex(secret);
/** Alias for clarity at call sites: device signing key = sha256(secret) hex. */
export const deviceSigningKey = deviceSecretHash;

/** Test/simulator helper: produces the X-Device-Signature value for a request. */
export function signDeviceRequest(secret: string, timestamp: string, body: string): string {
  return hmacHex(deviceSigningKey(secret), `${timestamp}.${body}`);
}

/** Generates a new raw credential secret (shown once; never persisted). */
export const newDeviceSecret = () => `znd_${randomBytes(32).toString("base64url")}`;

/* ── Credential lifecycle (staff-initiated) ───────────────────────────────── */

export type CredentialStatus =
  | { state: "none" }
  | { state: "pending"; authMethod: string }
  | { state: "active" | "expired" | "revoked"; authMethod: string; issuedAt: string | null; expiresAt: string | null; revokedAt: string | null; lastAuthedAt: string | null };

/** Pure display state — never exposes secret material. */
export function deviceCredentialStatus(device: DeviceAuthRow, now = new Date()): CredentialStatus {
  if (!device.device_secret_hash) {
    return device.auth_method && device.auth_method !== "pending" && device.auth_method !== "none"
      ? { state: "pending", authMethod: device.auth_method }
      : { state: "none" };
  }
  const base = {
    authMethod: device.auth_method ?? "hmac_sha256",
    issuedAt: device.credential_issued_at,
    expiresAt: device.credential_expires_at,
    revokedAt: device.credential_revoked_at,
    lastAuthedAt: device.last_authed_at,
  };
  if (device.credential_revoked_at) return { state: "revoked", ...base };
  const exp = device.credential_expires_at ? new Date(device.credential_expires_at).getTime() : null;
  if (exp != null && Number.isFinite(exp) && exp < now.getTime()) return { state: "expired", ...base };
  return { state: "active", ...base };
}

/**
 * Issues (or rotates) a device credential. Returns the raw secret EXACTLY ONCE.
 * Moves the device to 'provisioning' only when that edge is legal from its
 * current status — never forces an illegal lifecycle jump.
 */
export async function issueDeviceCredential(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; secret: string; expiresAt: string; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  if (device.status === "decommissioned") return { ok: false, status: 409, error: "Cannot issue a credential for a decommissioned device" };
  if (device.status === "quarantined") return { ok: false, status: 409, error: "Device is quarantined — resolve the quarantine before issuing credentials" };

  const secret = newDeviceSecret();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEVICE_CREDENTIAL_TTL_MS).toISOString();

  const patch: Record<string, unknown> = {
    device_secret_hash: deviceSecretHash(secret),
    credential_issued_at: nowIso,
    credential_expires_at: expiresAt,
    credential_revoked_at: null,
    auth_method: "hmac_sha256",
    last_message_ts: null, // rotation resets replay window
    updated_at: nowIso,
  };
  // Only advance lifecycle along a legal edge (registered→provisioning etc.).
  if (DEVICE_TRANSITIONS[device.status as SystemDeviceStatus]?.includes("provisioning")) {
    patch.status = "provisioning";
  }

  const { data, error } = await db.from("system_devices").update(patch).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_issued", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, auth_method: "hmac_sha256", expires_at: expiresAt, ttl_days: 365 },
  });
  return { ok: true, secret, expiresAt, device: data as DeviceAuthRow };
}

/** Revokes the device credential: clears the hash and stamps revoked_at. */
export async function revokeDeviceCredential(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  if (!device.device_secret_hash && !device.credential_issued_at) {
    return { ok: false, status: 409, error: "No credential to revoke" };
  }
  const { data, error } = await db.from("system_devices").update({
    device_secret_hash: null,
    credential_revoked_at: new Date().toISOString(),
    auth_method: "none",
    last_message_ts: null,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_revoked", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, auth_method: "none" },
  });
  return { ok: true, device: data as DeviceAuthRow };
}

/* ── Ingest verification ──────────────────────────────────────────────────── */

export type DeviceAuthSuccess = { ok: true; device: DeviceAuthRow };
export type DeviceAuthFailure = { ok: false; status: number; error: string; reason: string };
export type DeviceAuthResult = DeviceAuthSuccess | DeviceAuthFailure;

const fail = (status: number, error: string, reason: string): DeviceAuthFailure => ({ ok: false, status, error, reason });

/**
 * Appends one row to system_device_messages. Best-effort: telemetry must never
 * break ingest. `detail` must contain only non-secret context (reason codes,
 * device_uid, status) — callers must NOT pass signatures or secrets.
 */
export async function recordDeviceAuthMessage(
  db: SupabaseClient,
  msg: { deviceId?: string | null; messageType?: string; authMethod?: string | null; result: "ok" | "rejected"; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.from("system_device_messages").insert({
      device_id: msg.deviceId ?? null,
      message_type: (msg.messageType ?? "ingest").slice(0, 60),
      auth_method: msg.authMethod ?? null,
      result: msg.result,
      detail: msg.detail ?? {},
    });
  } catch { /* telemetry is best-effort */ }
}

async function findDevice(db: SupabaseClient, deviceId: string): Promise<DeviceAuthRow | null> {
  if (isUuid(deviceId)) {
    const { data } = await db.from("system_devices").select(AUTH_SELECT).eq("id", deviceId).maybeSingle();
    if (data) return data as DeviceAuthRow;
  }
  const { data } = await db.from("system_devices").select(AUTH_SELECT).eq("device_uid", deviceId).maybeSingle();
  return (data as DeviceAuthRow | null) ?? null;
}

/** Normalizes a unix seconds-or-ms timestamp header to epoch ms, or null. */
export function parseDeviceTimestamp(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/**
 * Verifies an HMAC-SHA256 device-authenticated ingest request.
 *
 * Checks (each rejection is recorded in system_device_messages):
 *  rate limit → device exists → auth_method='hmac_sha256' → credential present,
 *  not revoked, not expired → status active|testing → timestamp within ±5min →
 *  timestamp strictly newer than last_message_ts (replay) → signature match.
 * On success updates last_message_ts / last_authed_at / last_message_at.
 */
export async function verifyDeviceAuth(
  db: SupabaseClient,
  req: { deviceId: string; timestamp: string; signature: string; body: string },
  now = new Date(),
): Promise<DeviceAuthResult> {
  const deviceId = req.deviceId.trim();
  const rl = rateLimit(`devauth:${deviceId}`, DEVICE_AUTH_RATE.limit, DEVICE_AUTH_RATE.windowMs, now.getTime());
  if (!rl.ok) return fail(429, "Rate limited", "rate_limited");

  const device = await findDevice(db, deviceId);
  const reject = async (status: number, error: string, reason: string, authMethod?: string | null) => {
    await recordDeviceAuthMessage(db, {
      deviceId: device?.id ?? null,
      authMethod: authMethod ?? device?.auth_method ?? "hmac_sha256",
      result: "rejected",
      detail: { reason, device_uid: device?.device_uid ?? deviceId.slice(0, 80) },
    });
    return fail(status, error, reason);
  };

  if (!device) return reject(401, "Unknown device", "device_unknown");
  if (device.auth_method !== "hmac_sha256") {
    return reject(401, "Device is not enrolled for HMAC auth", "auth_method_not_hmac", device.auth_method);
  }
  if (!device.device_secret_hash) return reject(401, "No device credential issued", "no_credential");
  if (device.credential_revoked_at) return reject(401, "Device credential revoked", "credential_revoked");
  const exp = device.credential_expires_at ? new Date(device.credential_expires_at).getTime() : null;
  if (exp != null && Number.isFinite(exp) && exp < now.getTime()) {
    return reject(401, "Device credential expired", "credential_expired");
  }
  if (device.status !== "active" && device.status !== "testing") {
    return reject(403, `Device status ${device.status} cannot authenticate`, "device_status", device.auth_method);
  }

  const tsMs = parseDeviceTimestamp(req.timestamp);
  if (tsMs == null || Math.abs(now.getTime() - tsMs) > DEVICE_AUTH_WINDOW_MS) {
    return reject(401, "Timestamp missing, invalid, or outside the ±5 minute window", "bad_timestamp");
  }
  const lastTs = device.last_message_ts == null ? null : Number(device.last_message_ts);
  if (lastTs != null && Number.isFinite(lastTs) && tsMs <= lastTs) {
    return reject(401, "Stale or replayed timestamp", "replay");
  }

  const expected = hmacHex(device.device_secret_hash, `${req.timestamp}.${req.body}`);
  const provided = req.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided) || !safeEqHex(expected, provided)) {
    return reject(401, "Invalid signature", "bad_signature");
  }

  const nowIso = now.toISOString();
  await db.from("system_devices").update({
    last_message_ts: tsMs,
    last_authed_at: nowIso,
    last_message_at: nowIso,
    updated_at: nowIso,
  }).eq("id", device.id);
  await recordDeviceAuthMessage(db, {
    deviceId: device.id,
    authMethod: "hmac_sha256",
    result: "ok",
    detail: { device_uid: device.device_uid, message_type: "ingest" },
  });
  return { ok: true, device };
}

/**
 * True while the shared-secret ingest fallback is enabled. The flag is the
 * migration lever: set KIOSK_LEGACY_INGEST=1 while devices are being enrolled,
 * unset it to require per-device HMAC everywhere.
 */
export const legacyIngestEnabled = () => process.env.KIOSK_LEGACY_INGEST === "1";
