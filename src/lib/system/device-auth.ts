import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import { systemAudit, type SystemActor } from "./audit";
import { DEVICE_TRANSITIONS, deviceAuditResource, isUuid, type SystemDeviceStatus } from "./kiosks";

/**
 * Per-device kiosk ingest authentication — protocol v2 (HMAC-SHA256 + nonce dedup).
 *
 * Credential model:
 *  - `issueDeviceCredential` generates a 32-byte random secret, returns it ONCE,
 *    and persists `device_secret_enc` = AES-256-GCM ciphertext of the secret
 *    (key-wrapped by env DEVICE_CREDENTIAL_KEK) PLUS `device_secret_hash` =
 *    sha256(secret) as a non-reversible fingerprint ONLY. The raw secret is
 *    never stored, logged, or audited. Issuance REFUSES (503) when the KEK is
 *    unset or malformed — there is no hash-as-key fallback for new credentials.
 *  - The device uses `signingKey = hex(sha256(secret))` as the HMAC-SHA256 key
 *    over `${timestamp}.${rawBody}`. On verify, enc-mode rows decrypt the
 *    secret transiently in memory and derive the same key; the stored hash is
 *    NOT trusted as a key once enc exists (DB read access no longer forges
 *    signatures without also possessing the KEK).
 *  - LEGACY MODE: rows issued before v2 have device_secret_enc = null. They
 *    still verify with device_secret_hash used directly as the HMAC key, and
 *    the ok telemetry row is marked detail.key_mode='legacy_hash' so migration
 *    debt is visible. Legacy mode ends when every device has been re-issued a
 *    v2 credential (issue → device re-provisions → revoke old).
 *
 * Request contract (v2 headers):
 *  - X-Device-Id            device_uid or uuid (required)
 *  - X-Device-Timestamp     unix seconds or ms, must be within ±5 min of now
 *  - X-Device-Signature     hex HMAC-SHA256 over `${timestamp}.${rawBody}`
 *  - X-Device-Message-Id    REQUIRED for the hmac path: 8–128 chars of
 *                           [A-Za-z0-9_-]. Unique per device — the dedup nonce.
 *  - X-Device-Protocol      OPTIONAL int (default 1), recorded on the message row.
 *
 * Replay/dedup semantics:
 *  - Timestamp must be inside the ±5min window but NO LONGER must strictly
 *    increase — out-of-order telemetry is accepted and last_message_ts only
 *    ever moves forward (max()). Replay protection is the message_id nonce:
 *    after signature verification an atomic claim row is inserted into
 *    system_device_messages (message_type='claim'); the partial unique index
 *    on (device_id, message_id) is the race-safe arbiter. A unique violation
 *    → 409 'duplicate_message' plus a rejected telemetry row WITHOUT message_id.
 *  - Every attempt — ok or rejected — writes system_device_messages rows with
 *    auth_method + result + short reason. Secrets, signatures, enc payloads,
 *    and hashes are NEVER recorded or returned.
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

/** X-Device-Message-Id format: 8–128 chars of [A-Za-z0-9_-]. */
export const DEVICE_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** Sanity bound for X-Device-Protocol. */
export const DEVICE_PROTOCOL_MAX = 999;

/** Columns device-auth needs — a subset of system_devices. */
export type DeviceAuthRow = {
  id: string;
  device_uid: string | null;
  serial_number: string | null;
  status: SystemDeviceStatus | string;
  auth_method: DeviceAuthMethod | string | null;
  device_secret_hash: string | null;
  /** AES-256-GCM ciphertext 'v1.<iv>.<tag>.<ct>' (hex) — optional because some
   *  selects (SYSTEM_DEVICE_SELECT) predate the column; treat undefined as null. */
  device_secret_enc?: string | null;
  credential_issued_at: string | null;
  credential_expires_at: string | null;
  credential_revoked_at: string | null;
  last_authed_at: string | null;
  last_message_ts: number | string | null;
};

const AUTH_SELECT =
  "id,device_uid,serial_number,status,auth_method,device_secret_hash,device_secret_enc,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts";

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmacHex = (key: string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest("hex");
const safeEqHex = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Non-reversible fingerprint of the secret. For LEGACY rows (no enc) it is
 *  still used as the HMAC key — see header comment. Never returned by APIs. */
export const deviceSecretHash = (secret: string) => sha256hex(secret);
/** The device-side signing key: hex(sha256(secret)). */
export const deviceSigningKey = deviceSecretHash;

/** Test/simulator helper: produces the X-Device-Signature value for a request. */
export function signDeviceRequest(secret: string, timestamp: string, body: string): string {
  return hmacHex(deviceSigningKey(secret), `${timestamp}.${body}`);
}

/* ── KEK + secret encryption (AES-256-GCM) ────────────────────────────────── */

const KEK_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Reads + validates DEVICE_CREDENTIAL_KEK: exactly 64 hex chars (32 bytes).
 * Throws when unset or malformed — every caller fails closed; there is no
 * silent fallback to storing/verifying key material in recoverable form.
 */
function kek(): Buffer {
  const raw = process.env.DEVICE_CREDENTIAL_KEK?.trim();
  if (!raw) throw new Error("DEVICE_CREDENTIAL_KEK not configured");
  if (!KEK_HEX_RE.test(raw)) throw new Error("DEVICE_CREDENTIAL_KEK must be 64 hex characters (32 bytes)");
  return Buffer.from(raw, "hex");
}

/**
 * Encrypts a device secret: AES-256-GCM, random 12-byte IV, output
 * `v1.<iv_hex>.<tag_hex>.<ct_hex>`. Throws when the KEK is unavailable.
 */
export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek(), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}

/** Reverses encryptSecret. Throws on malformed input, wrong KEK, or tampering. */
export function decryptSecret(enc: string): string {
  const parts = enc.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported credential encoding");
  const [, ivHex, tagHex, ctHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", kek(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

/** Generates a new raw credential secret (shown once; never persisted). */
export const newDeviceSecret = () => `znd_${randomBytes(32).toString("base64url")}`;

/* ── Credential lifecycle (staff-initiated) ───────────────────────────────── */

export type CredentialStatus =
  | { state: "none" }
  | { state: "pending"; authMethod: string }
  | { state: "active" | "expired" | "revoked"; authMethod: string; issuedAt: string | null; expiresAt: string | null; revokedAt: string | null; lastAuthedAt: string | null };

/** True when the device holds a usable credential (enc or legacy hash). */
const hasCredential = (d: DeviceAuthRow) => !!(d.device_secret_enc || d.device_secret_hash);

/** Pure display state — never exposes secret material. */
export function deviceCredentialStatus(device: DeviceAuthRow, now = new Date()): CredentialStatus {
  if (!hasCredential(device)) {
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
 * Requires DEVICE_CREDENTIAL_KEK — refuses with an honest error when unset or
 * malformed (never falls back to hash-as-key for new credentials). Moves the
 * device to 'provisioning' only when that edge is legal from its current status.
 */
export async function issueDeviceCredential(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; secret: string; expiresAt: string; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  if (device.status === "decommissioned") return { ok: false, status: 409, error: "Cannot issue a credential for a decommissioned device" };
  if (device.status === "quarantined") return { ok: false, status: 409, error: "Device is quarantined — resolve the quarantine before issuing credentials" };

  const secret = newDeviceSecret();
  let enc: string;
  try {
    enc = encryptSecret(secret);
  } catch (e) {
    // Fail closed: no KEK → no new credentials (existing legacy creds unaffected).
    return { ok: false, status: 503, error: e instanceof Error ? e.message : "Credential encryption unavailable" };
  }
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEVICE_CREDENTIAL_TTL_MS).toISOString();

  const patch: Record<string, unknown> = {
    device_secret_enc: enc,
    device_secret_hash: deviceSecretHash(secret), // fingerprint only — NOT the v2 HMAC key
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
    detail: { device_uid: device.device_uid, auth_method: "hmac_sha256", credential_format: "aes256gcm_v1", expires_at: expiresAt, ttl_days: 365 },
  });
  return { ok: true, secret, expiresAt, device: data as DeviceAuthRow };
}

/** Revokes the device credential: clears enc + hash and stamps revoked_at. */
export async function revokeDeviceCredential(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  if (!hasCredential(device) && !device.credential_issued_at) {
    return { ok: false, status: 409, error: "No credential to revoke" };
  }
  const { data, error } = await db.from("system_devices").update({
    device_secret_enc: null,
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

export type DeviceAuthSuccess = { ok: true; device: DeviceAuthRow; keyMode: "enc" | "legacy_hash" };
export type DeviceAuthFailure = { ok: false; status: number; error: string; reason: string };
export type DeviceAuthResult = DeviceAuthSuccess | DeviceAuthFailure;

const fail = (status: number, error: string, reason: string): DeviceAuthFailure => ({ ok: false, status, error, reason });

/**
 * Appends one row to system_device_messages. Best-effort: telemetry must never
 * break ingest. `detail` must contain only non-secret context (reason codes,
 * device_uid, status, key_mode) — callers must NOT pass secrets, signatures,
 * enc payloads, or hashes.
 *
 * NOTE: when messageId is supplied the row carries the (device_id, message_id)
 * dedup columns — a second row with the same pair is rejected by the unique
 * index and silently dropped. That is intentional: the 'claim' row written by
 * verifyDeviceAuth is the dedup-authoritative record.
 */
export async function recordDeviceAuthMessage(
  db: SupabaseClient,
  msg: {
    deviceId?: string | null;
    messageType?: string;
    authMethod?: string | null;
    result: "ok" | "rejected";
    detail?: Record<string, unknown>;
    messageId?: string | null;
    protocolVersion?: number | null;
    payloadSha256?: string | null;
  },
): Promise<void> {
  try {
    await db.from("system_device_messages").insert({
      device_id: msg.deviceId ?? null,
      message_type: (msg.messageType ?? "ingest").slice(0, 60),
      auth_method: msg.authMethod ?? null,
      result: msg.result,
      detail: msg.detail ?? {},
      ...(msg.messageId != null
        ? { message_id: msg.messageId, protocol_version: msg.protocolVersion ?? null, payload_sha256: msg.payloadSha256 ?? null }
        : {}),
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

export type DeviceAuthRequest = {
  deviceId: string;
  timestamp: string;
  signature: string;
  body: string;
  /** X-Device-Message-Id — required nonce for dedup (8–128 [A-Za-z0-9_-]). */
  messageId?: string | null;
  /** X-Device-Protocol — optional int, default 1. */
  protocolVersion?: number | null;
  /** sha256(rawBody) hex — computed by the caller; defaults to sha256(body). */
  bodyHash?: string | null;
};

/**
 * Verifies an HMAC-SHA256 device-authenticated ingest request (protocol v2).
 *
 * Checks (each rejection is recorded in system_device_messages):
 *  rate limit → message_id present + well-formed → protocol_version sane →
 *  device exists → auth_method='hmac_sha256' → credential present (enc or
 *  legacy hash), not revoked, not expired → status active|testing → timestamp
 *  within ±5min → signature match (enc: decrypt→sha256(secret); legacy:
 *  hash-as-key) → atomic message_id dedup claim → last_message_ts advances
 *  to max(ts, existing) only.
 * On success returns { ok, device, keyMode } — keyMode 'legacy_hash' flags
 * pre-v2 credentials still awaiting rotation.
 */
export async function verifyDeviceAuth(
  db: SupabaseClient,
  req: DeviceAuthRequest,
  now = new Date(),
): Promise<DeviceAuthResult> {
  const deviceId = req.deviceId.trim();
  const rl = rateLimit(`devauth:${deviceId}`, DEVICE_AUTH_RATE.limit, DEVICE_AUTH_RATE.windowMs, now.getTime());
  if (!rl.ok) return fail(429, "Rate limited", "rate_limited");

  // ── v2 required headers (validated before any DB work) ──────────────────
  const messageId = (req.messageId ?? "").trim();
  const rejectEarly = async (status: number, error: string, reason: string) => {
    await recordDeviceAuthMessage(db, {
      deviceId: null,
      authMethod: "hmac_sha256",
      result: "rejected",
      detail: { reason, device_uid: deviceId.slice(0, 80) },
    });
    return fail(status, error, reason);
  };
  if (!messageId) return rejectEarly(401, "Missing X-Device-Message-Id", "missing_message_id");
  if (!DEVICE_MESSAGE_ID_RE.test(messageId)) return rejectEarly(401, "Invalid X-Device-Message-Id", "invalid_message_id");
  const protocolVersion = req.protocolVersion ?? 1;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1 || protocolVersion > DEVICE_PROTOCOL_MAX) {
    return rejectEarly(400, "Invalid X-Device-Protocol", "invalid_protocol_version");
  }

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
  if (!hasCredential(device)) return reject(401, "No device credential issued", "no_credential");
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
  const lastTsMs = lastTs != null && Number.isFinite(lastTs) ? lastTs : null;

  // ── Resolve the HMAC key ────────────────────────────────────────────────
  // enc mode: decrypt the stored ciphertext (KEK-wrapped) and derive
  // sha256(secret) transiently — the hash column is NOT used as the key.
  // legacy mode: pre-v2 rows have no enc; hash-as-key until the device rotates.
  let signingKey: string;
  let keyMode: "enc" | "legacy_hash";
  if (device.device_secret_enc) {
    let secret: string;
    try {
      secret = decryptSecret(device.device_secret_enc);
    } catch {
      return reject(503, "Device credential cannot be decrypted (KEK missing or ciphertext corrupt)", "key_decrypt_failed");
    }
    signingKey = deviceSecretHash(secret);
    keyMode = "enc";
  } else {
    signingKey = device.device_secret_hash as string;
    keyMode = "legacy_hash";
  }

  const expected = hmacHex(signingKey, `${req.timestamp}.${req.body}`);
  const provided = req.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided) || !safeEqHex(expected, provided)) {
    return reject(401, "Invalid signature", "bad_signature");
  }

  // ── Atomic dedup claim (unique index on device_id+message_id is the
  //    race-safe arbiter — no check-then-act TOCTOU). ──────────────────────
  const payloadSha256 = req.bodyHash ?? sha256hex(req.body);
  const { error: claimError } = await db.from("system_device_messages").insert({
    device_id: device.id,
    message_id: messageId,
    message_type: "claim",
    auth_method: "hmac_sha256",
    result: "ok",
    protocol_version: protocolVersion,
    payload_sha256: payloadSha256,
    detail: { device_uid: device.device_uid, key_mode: keyMode, dedup: "claim" },
  });
  if (claimError) {
    if (claimError.code === "23505") {
      // Duplicate nonce — record the rejection WITHOUT message_id so the
      // telemetry row itself cannot trip the same unique index.
      await recordDeviceAuthMessage(db, {
        deviceId: device.id,
        authMethod: "hmac_sha256",
        result: "rejected",
        detail: { reason: "duplicate_message", message_id: messageId, device_uid: device.device_uid },
      });
      return fail(409, "Duplicate message id", "duplicate_message");
    }
    // Fail closed: without the dedup arbiter we cannot prove non-replay.
    return reject(503, "Message log unavailable — cannot verify message uniqueness", "dedup_unavailable");
  }

  const nowIso = now.toISOString();
  await db.from("system_devices").update({
    last_message_ts: lastTsMs != null ? Math.max(tsMs, lastTsMs) : tsMs, // never regress
    last_authed_at: nowIso,
    last_message_at: nowIso,
    updated_at: nowIso,
  }).eq("id", device.id);
  await recordDeviceAuthMessage(db, {
    deviceId: device.id,
    authMethod: "hmac_sha256",
    result: "ok",
    messageId,
    protocolVersion,
    payloadSha256,
    detail: { device_uid: device.device_uid, message_type: "ingest", key_mode: keyMode },
  });
  // Never hand credential material to callers — blank enc/hash on the way out.
  return { ok: true, device: { ...device, device_secret_hash: null, device_secret_enc: null }, keyMode };
}

/**
 * True while the shared-secret ingest fallback is enabled. The flag is the
 * migration lever: set KIOSK_LEGACY_INGEST=1 while devices are being enrolled,
 * unset it to require per-device HMAC everywhere.
 */
export const legacyIngestEnabled = () => process.env.KIOSK_LEGACY_INGEST === "1";
