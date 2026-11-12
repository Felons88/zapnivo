import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability";
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
 *  - Ciphertext format v2: `v2.<keyver>.<iv_hex>.<tag_hex>.<ct_hex>` where
 *    keyver comes from DEVICE_CREDENTIAL_KEK_VERSION (default 'k1') and the
 *    AES-GCM AAD is the device uuid — ciphertext is bound to its row and
 *    cannot be swapped between devices. Legacy `v1.<iv>.<tag>.<ct>` payloads
 *    (no AAD, no keyver) still decrypt for pre-existing rows.
 *  - KEK rotation: DEVICE_CREDENTIAL_KEK_PREVIOUS (64-hex) is tried after the
 *    current KEK on decrypt failure, enabling staged rotation. Re-encryption
 *    is manual per device via reencryptDeviceCredential (verify-before-write).
 *  - ZERO-DOWNTIME ROTATION: startCredentialRotation stages a new secret in
 *    device_secret_enc_next (overlap window = rotationWindowMs(), env
 *    DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS, default 72h, clamp 1–168h).
 *    During the overlap BOTH credentials
 *    verify; the first successful auth with the next secret promotes it to
 *    the primary slot. cancelCredentialRotation / revokeDeviceCredential clear
 *    the pending slot (revoke clears both).
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
  /** AES-256-GCM ciphertext — 'v2.<keyver>.<iv>.<tag>.<ct>' (AAD=device.id) or
   *  legacy 'v1.<iv>.<tag>.<ct>' (no AAD). Optional because some selects
   *  predate the column; treat undefined as null. */
  device_secret_enc?: string | null;
  /** Staged next credential during a zero-downtime rotation window (0048). */
  device_secret_enc_next?: string | null;
  credential_next_expires_at?: string | null;
  credential_rotated_at?: string | null;
  credential_issued_at: string | null;
  credential_expires_at: string | null;
  credential_revoked_at: string | null;
  last_authed_at: string | null;
  last_message_ts: number | string | null;
};

const AUTH_SELECT =
  "id,device_uid,serial_number,status,auth_method,device_secret_hash,device_secret_enc,device_secret_enc_next,credential_next_expires_at,credential_rotated_at,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts";

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
 * Used for ENCRYPTION (current KEK only — never the previous one).
 */
function kek(): Buffer {
  const raw = process.env.DEVICE_CREDENTIAL_KEK?.trim();
  if (!raw) throw new Error("DEVICE_CREDENTIAL_KEK not configured");
  if (!KEK_HEX_RE.test(raw)) throw new Error("DEVICE_CREDENTIAL_KEK must be 64 hex characters (32 bytes)");
  return Buffer.from(raw, "hex");
}

const KEYVER_RE = /^[A-Za-z0-9_-]{1,24}$/;

/**
 * Version tag embedded in v2 ciphertexts (DEVICE_CREDENTIAL_KEK_VERSION,
 * default 'k1'). Bump it when the KEK changes so telemetry/audit can tell
 * which key generation a credential belongs to — it is a label, not a secret.
 */
export function kekVersion(): string {
  const v = process.env.DEVICE_CREDENTIAL_KEK_VERSION?.trim();
  return v && KEYVER_RE.test(v) ? v : "k1";
}

/** Env-presence-only KEK status for ops surfaces — NEVER returns key material. */
export function kekStatus(): { configured: boolean; current_version: string; previous_configured: boolean } {
  const cur = process.env.DEVICE_CREDENTIAL_KEK?.trim();
  const prev = process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS?.trim();
  return {
    configured: !!cur && KEK_HEX_RE.test(cur),
    current_version: kekVersion(),
    previous_configured: !!prev && KEK_HEX_RE.test(prev),
  };
}

function kekFromEnv(name: "DEVICE_CREDENTIAL_KEK" | "DEVICE_CREDENTIAL_KEK_PREVIOUS"): Buffer | null {
  const raw = process.env[name]?.trim();
  if (!raw || !KEK_HEX_RE.test(raw)) return null; // malformed → skipped, never thrown mid-decrypt
  return Buffer.from(raw, "hex");
}

/**
 * Ordered candidate KEKs for DECRYPTION: current first, then the optional
 * DEVICE_CREDENTIAL_KEK_PREVIOUS. Trying previous on failure is what makes a
 * staged KEK rotation possible without re-encrypting every row up front.
 */
function kekCandidates(): Buffer[] {
  const out: Buffer[] = [];
  const cur = kekFromEnv("DEVICE_CREDENTIAL_KEK");
  const prev = kekFromEnv("DEVICE_CREDENTIAL_KEK_PREVIOUS");
  if (cur) out.push(cur);
  if (prev && (!cur || !prev.equals(cur))) out.push(prev);
  return out;
}

type ParsedCredential = {
  keyVersion: string; // 'v1' for legacy payloads, else the v2 keyver tag
  aadBound: boolean;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
};

const HEX_RE = /^[0-9a-fA-F]+$/;

function parseCredentialEnc(enc: string): ParsedCredential {
  const parts = enc.split(".");
  if (parts[0] === "v1" && parts.length === 4) {
    const [, ivHex, tagHex, ctHex] = parts;
    if (!HEX_RE.test(ivHex) || ivHex.length !== 24 || !HEX_RE.test(tagHex) || tagHex.length !== 32 || !HEX_RE.test(ctHex) || ctHex.length === 0) {
      throw new Error("malformed credential encoding");
    }
    return { keyVersion: "v1", aadBound: false, iv: Buffer.from(ivHex, "hex"), tag: Buffer.from(tagHex, "hex"), ct: Buffer.from(ctHex, "hex") };
  }
  if (parts[0] === "v2" && parts.length === 5) {
    const [, keyver, ivHex, tagHex, ctHex] = parts;
    if (!KEYVER_RE.test(keyver) || !HEX_RE.test(ivHex) || ivHex.length !== 24 || !HEX_RE.test(tagHex) || tagHex.length !== 32 || !HEX_RE.test(ctHex) || ctHex.length === 0) {
      throw new Error("malformed credential encoding");
    }
    return { keyVersion: keyver, aadBound: true, iv: Buffer.from(ivHex, "hex"), tag: Buffer.from(tagHex, "hex"), ct: Buffer.from(ctHex, "hex") };
  }
  throw new Error("unsupported credential encoding");
}

/** Single-key decrypt attempt — returns null on ANY failure (wrong key, bad AAD, tamper). */
function tryDecrypt(parsed: ParsedCredential, key: Buffer, aad: string | undefined): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    if (parsed.aadBound) {
      if (!aad) return null; // v2 without the device AAD can never verify
      decipher.setAAD(Buffer.from(aad, "utf8"));
    }
    return Buffer.concat([decipher.update(parsed.ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

type DecryptedCredential = { secret: string; keyVersion: string };

/**
 * Decrypts a credential payload trying each candidate KEK in order
 * (current → previous). `aad` MUST be the owning device.id for v2 payloads —
 * a ciphertext copied to another device row fails the GCM tag check.
 * Throws when no candidate succeeds or none is configured.
 */
function decryptSecretAny(enc: string, aad?: string): DecryptedCredential {
  const parsed = parseCredentialEnc(enc);
  const candidates = kekCandidates();
  if (candidates.length === 0) throw new Error("DEVICE_CREDENTIAL_KEK not configured");
  for (const key of candidates) {
    const secret = tryDecrypt(parsed, key, aad);
    if (secret != null) return { secret, keyVersion: parsed.keyVersion };
  }
  throw new Error("credential decrypt failed");
}

/**
 * Encrypts a device secret under the CURRENT KEK: AES-256-GCM, random 12-byte
 * IV, output `v2.<keyver>.<iv_hex>.<tag_hex>.<ct_hex>` with `aad` (the device
 * uuid) bound via setAAD. Throws when the KEK is unavailable.
 */
export function encryptSecret(secret: string, aad?: string, keyver?: string): string {
  const kv = keyver ?? kekVersion();
  if (!KEYVER_RE.test(kv)) throw new Error("invalid credential key version");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v2.${kv}.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
}

/**
 * Reverses encryptSecret — v2 (AAD-bound) and legacy v1 (no AAD) payloads,
 * trying current then previous KEK. Throws on malformed input, wrong KEKs,
 * AAD mismatch, or tampering.
 */
export function decryptSecret(enc: string, aad?: string): string {
  return decryptSecretAny(enc, aad).secret;
}

/** Non-secret key-generation label for telemetry ('v1', 'k1', …). Never key material. */
export function credentialKeyVersion(enc: string | null | undefined): string {
  if (!enc) return "none";
  try {
    return parseCredentialEnc(enc).keyVersion;
  } catch {
    return "unknown";
  }
}

/** Generates a new raw credential secret (shown once; never persisted). */
export const newDeviceSecret = () => `znd_${randomBytes(32).toString("base64url")}`;

/* ── Credential lifecycle (staff-initiated) ───────────────────────────────── */

export type CredentialStatus =
  | { state: "none" }
  | { state: "pending"; authMethod: string }
  | {
      state: "active" | "expired" | "revoked";
      authMethod: string;
      issuedAt: string | null;
      expiresAt: string | null;
      revokedAt: string | null;
      lastAuthedAt: string | null;
      /** True while a zero-downtime rotation window is open (next slot live). */
      rotationPending: boolean;
      /** True when a staged next slot exists but its window already lapsed
       *  (awaiting sweepExpiredRotations cleanup). */
      rotationOverdue: boolean;
      /** Hours since the pending rotation was staged (derived from the
       *  configured window; display-only estimate). 0 when none pending. */
      rotationAgeHours: number;
      rotationNextExpiresAt: string | null;
    };

/** True when the device holds a usable credential (enc or legacy hash). */
const hasCredential = (d: DeviceAuthRow) => !!(d.device_secret_enc || d.device_secret_hash);

/** Pure display state — never exposes secret material. */
export function deviceCredentialStatus(device: DeviceAuthRow, now = new Date()): CredentialStatus {
  if (!hasCredential(device)) {
    return device.auth_method && device.auth_method !== "pending" && device.auth_method !== "none"
      ? { state: "pending", authMethod: device.auth_method }
      : { state: "none" };
  }
  const nextExpMs = device.credential_next_expires_at ? Date.parse(device.credential_next_expires_at) : NaN;
  const hasNextSlot = !!device.device_secret_enc_next;
  const rotationPending = hasNextSlot && Number.isFinite(nextExpMs) && nextExpMs > now.getTime();
  // A staged slot whose window already lapsed is "overdue" — it can no longer
  // authenticate (verify path ignores it) and is cleared by the retention sweep.
  const rotationOverdue = hasNextSlot && Number.isFinite(nextExpMs) && nextExpMs <= now.getTime();
  // Best-effort age: staged-at is derived as expiry − the configured window.
  // Display-only — the exact staging instant is not persisted.
  const stagedAtMs = Number.isFinite(nextExpMs) ? nextExpMs - rotationWindowMs() : NaN;
  const rotationAgeHours = hasNextSlot && Number.isFinite(stagedAtMs)
    ? Math.max(0, Math.round(((now.getTime() - stagedAtMs) / 3_600_000) * 10) / 10)
    : 0;
  const base = {
    authMethod: device.auth_method ?? "hmac_sha256",
    issuedAt: device.credential_issued_at,
    expiresAt: device.credential_expires_at,
    revokedAt: device.credential_revoked_at,
    lastAuthedAt: device.last_authed_at,
    rotationPending,
    rotationOverdue,
    rotationAgeHours,
    rotationNextExpiresAt: hasNextSlot ? (device.credential_next_expires_at ?? null) : null,
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
    enc = encryptSecret(secret, device.id); // v2 — AAD-bound to this device row
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
    detail: { device_uid: device.device_uid, auth_method: "hmac_sha256", credential_format: "aes256gcm_v2", kek_version: kekVersion(), expires_at: expiresAt, ttl_days: 365 },
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
    device_secret_enc_next: null, // revoke clears BOTH credential slots
    credential_next_expires_at: null,
    device_secret_hash: null,
    credential_revoked_at: new Date().toISOString(),
    auth_method: "none",
    last_message_ts: null,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_revoked", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, auth_method: "none", rotation_pending_cleared: !!device.device_secret_enc_next },
  });
  return { ok: true, device: data as DeviceAuthRow };
}

/* ── Zero-downtime credential rotation (staged next slot) ────────────────── */

const ROTATION_WINDOW_DEFAULT_HOURS = 72;
const ROTATION_WINDOW_MIN_HOURS = 1;
const ROTATION_WINDOW_MAX_HOURS = 168; // 7 days

/**
 * Overlap window (ms) during which BOTH the current and the staged-next
 * credential verify. Configurable via DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS:
 * default 72h, clamped to 1–168h, invalid/missing → 72h. Read at call time so
 * env changes take effect without a redeploy of this module.
 */
export function rotationWindowMs(): number {
  const raw = process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS?.trim();
  if (!raw) return ROTATION_WINDOW_DEFAULT_HOURS * 3_600_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return ROTATION_WINDOW_DEFAULT_HOURS * 3_600_000;
  const clamped = Math.min(Math.max(hours, ROTATION_WINDOW_MIN_HOURS), ROTATION_WINDOW_MAX_HOURS);
  return clamped * 3_600_000;
}

/** Fetches the auth-relevant columns for one device by uuid (null when absent). */
export async function getDeviceAuthRow(db: SupabaseClient, id: string): Promise<DeviceAuthRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db.from("system_devices").select(AUTH_SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as DeviceAuthRow;
}

/**
 * Starts a zero-downtime credential rotation: generates a NEW secret, stores
 * its KEK-encrypted form (AAD=device.id) in device_secret_enc_next with the
 * configured overlap window (rotationWindowMs()), and leaves the CURRENT credential fully valid. The device must
 * authenticate once with the new secret for promotion to happen (see
 * verifyDeviceAuth); until then both secrets verify. The new raw secret is
 * returned ONCE so it can be provisioned to the device — same contract as
 * issueDeviceCredential.
 */
export async function startCredentialRotation(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; secret: string; nextExpiresAt: string; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  if (device.status === "decommissioned") return { ok: false, status: 409, error: "Cannot rotate a credential for a decommissioned device" };
  if (device.status === "quarantined") return { ok: false, status: 409, error: "Device is quarantined — resolve the quarantine before rotating credentials" };
  if (!hasCredential(device)) return { ok: false, status: 409, error: "No credential to rotate — issue one first" };
  if (device.device_secret_enc_next) {
    const exp = device.credential_next_expires_at ? Date.parse(device.credential_next_expires_at) : NaN;
    if (!Number.isFinite(exp) || exp > Date.now()) {
      return { ok: false, status: 409, error: "A credential rotation is already pending — cancel it or wait for promotion/expiry" };
    }
  }

  const secret = newDeviceSecret();
  let encNext: string;
  try {
    encNext = encryptSecret(secret, device.id);
  } catch (e) {
    return { ok: false, status: 503, error: e instanceof Error ? e.message : "Credential encryption unavailable" };
  }
  const windowMs = rotationWindowMs();
  const nextExpiresAt = new Date(Date.now() + windowMs).toISOString();

  const { data, error } = await db.from("system_devices").update({
    device_secret_enc_next: encNext,
    credential_next_expires_at: nextExpiresAt,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_rotation_started", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, kek_version: kekVersion(), next_expires_at: nextExpiresAt, window_hours: windowMs / 3_600_000 },
  });
  return { ok: true, secret, nextExpiresAt, device: data as DeviceAuthRow };
}

/** Cancels a pending rotation: clears the staged next slot. Primary untouched. */
export async function cancelCredentialRotation(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  actor: SystemActor,
): Promise<{ ok: true; device: DeviceAuthRow } | { ok: false; status: number; error: string }> {
  const exp = device.credential_next_expires_at ? Date.parse(device.credential_next_expires_at) : NaN;
  const pending = !!device.device_secret_enc_next && (!Number.isFinite(exp) || exp > Date.now());
  if (!pending) return { ok: false, status: 409, error: "No pending credential rotation to cancel" };
  const { data, error } = await db.from("system_devices").update({
    device_secret_enc_next: null,
    credential_next_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_rotation_cancelled", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid },
  });
  return { ok: true, device: data as DeviceAuthRow };
}

/** Max devices one sweep run will clear — backlog drains over successive runs. */
export const ROTATION_SWEEP_LIMIT = 100;

/**
 * Safety sweep for lapsed rotation windows: finds devices whose staged
 * `device_secret_enc_next` exists but `credential_next_expires_at` is already
 * past, clears ONLY the next-slot fields (primary credential untouched), and
 * audits `kiosk.credential_rotation_expired` per device. This is NOT a
 * deletion — the primary credential stays valid; it just removes dead staged
 * material so status surfaces stop reporting it and no expired secret can ever
 * be promoted. Bounded to `limit` (≤ ROTATION_SWEEP_LIMIT) rows per call and
 * idempotent: cleared rows no longer match the filter. Called by the retention
 * cron AFTER runRetention — deliberately NOT part of runRetention, which is
 * approval-gated destructive deletion.
 */
export async function sweepExpiredRotations(
  db: SupabaseClient,
  actor: SystemActor | null = { id: "cron", role: "system" },
  limit = ROTATION_SWEEP_LIMIT,
): Promise<{ ok: boolean; swept: number; error?: string }> {
  const cap = Math.min(Math.max(Math.floor(limit) || ROTATION_SWEEP_LIMIT, 1), ROTATION_SWEEP_LIMIT);
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("system_devices")
    .select("id,device_uid,device_secret_enc_next,credential_next_expires_at")
    .not("device_secret_enc_next", "is", null)
    .lt("credential_next_expires_at", nowIso)
    .limit(cap);
  if (error) return { ok: false, swept: 0, error: error.message };

  const rows = (data ?? []) as { id: string; device_uid: string | null; device_secret_enc_next: string | null; credential_next_expires_at: string | null }[];
  let swept = 0;
  for (const row of rows) {
    // Clear ONLY the pending slot — never touch primary credential fields.
    const { error: uerr } = await db.from("system_devices").update({
      device_secret_enc_next: null,
      credential_next_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (uerr) continue; // best-effort per row; the next run retries it
    swept += 1;
    await systemAudit(db, {
      actor,
      action: "kiosk.credential_rotation_expired",
      resource: deviceAuditResource(row.id),
      detail: { device_uid: row.device_uid, next_expires_at: row.credential_next_expires_at },
    });
  }
  return { ok: true, swept };
}

/**
 * Promotes a verified next-slot credential to primary. Called from
 * verifyDeviceAuth on the first successful auth with the new secret. Returns
 * true when the guarded update actually landed (guards against a concurrent
 * cancel/second promotion racing this request).
 */
async function promoteCredentialRotation(
  db: SupabaseClient,
  device: DeviceAuthRow & { id: string },
  nextEnc: string,
  nextSecret: string,
  nextKeyVersion: string,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await db.from("system_devices").update({
    device_secret_enc: nextEnc,
    device_secret_enc_next: null,
    credential_next_expires_at: null,
    device_secret_hash: deviceSecretHash(nextSecret), // fresh fingerprint for the promoted secret
    credential_issued_at: nowIso,
    credential_expires_at: new Date(now.getTime() + DEVICE_CREDENTIAL_TTL_MS).toISOString(),
    credential_revoked_at: null,
    credential_rotated_at: nowIso,
    last_message_ts: null, // new credential → fresh replay window
    updated_at: nowIso,
  }).eq("id", device.id).eq("device_secret_enc_next", nextEnc).select("id").maybeSingle();
  if (error || !data) return false;
  await systemAudit(db, {
    actor: null, // system-initiated promotion on first successful next-auth
    action: "kiosk.credential_rotation_completed", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, kek_version: nextKeyVersion, trigger: "first_next_auth" },
  });
  return true;
}

/**
 * KEK-rotation helper: decrypts the device's stored credential(s) with ANY
 * candidate KEK (current → previous), re-encrypts under the CURRENT KEK, and
 * — only after a successful decrypt→encrypt→decrypt roundtrip — writes the row.
 * Audited as kiosk.credential_reencrypted. Manual per-device step; there is NO
 * automatic KEK rotation.
 */
export async function reencryptDeviceCredential(
  db: SupabaseClient,
  deviceId: string,
  actor: SystemActor,
): Promise<{ ok: true; device: DeviceAuthRow; slots: string[] } | { ok: false; status: number; error: string }> {
  const device = await getDeviceAuthRow(db, deviceId);
  if (!device) return { ok: false, status: 404, error: "Device not found" };

  const patch: Record<string, unknown> = {};
  const slots: string[] = [];
  const reencryptSlot = (enc: string, aad: string, column: "device_secret_enc" | "device_secret_enc_next"): string => {
    const { secret } = decryptSecretAny(enc, aad); // throws when no candidate KEK works
    const fresh = encryptSecret(secret, aad); // current KEK + current keyver
    // Verify-before-write: the new ciphertext MUST roundtrip to the same secret.
    if (decryptSecret(fresh, aad) !== secret) throw new Error("reencrypt roundtrip verification failed");
    patch[column] = fresh;
    slots.push(column);
    return fresh;
  };

  try {
    if (device.device_secret_enc) reencryptSlot(device.device_secret_enc, device.id, "device_secret_enc");
    if (device.device_secret_enc_next) reencryptSlot(device.device_secret_enc_next, device.id, "device_secret_enc_next");
  } catch (e) {
    return { ok: false, status: 503, error: e instanceof Error ? e.message : "Credential re-encryption failed" };
  }
  if (slots.length === 0) return { ok: false, status: 409, error: "No encrypted credential to re-encrypt (legacy hash-only or empty)" };

  patch.updated_at = new Date().toISOString();
  const { data, error } = await db.from("system_devices").update(patch).eq("id", device.id).select(AUTH_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.credential_reencrypted", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, slots, kek_version: kekVersion() },
  });
  return { ok: true, device: data as DeviceAuthRow, slots };
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

  // Phase 2.5 alert emitter (device.revoked_credential_attempts): a rejected
  // auth attempt against a revoked/expired credential emits a warning via
  // reportError → error_events/error_issues. The message is stable per
  // device+reason so the fingerprint dedups to one grouped issue; scope is
  // the device id/uid + coarse reason code only — never secrets, signatures,
  // or hashes. Fire-and-forget: no extra queries, alerting never blocks ingest.
  if (msg.result === "rejected") {
    const reason = typeof msg.detail?.reason === "string" ? msg.detail.reason : "";
    if (reason === "credential_revoked" || reason === "credential_expired") {
      const scope =
        msg.deviceId ??
        (typeof msg.detail?.device_uid === "string" ? msg.detail.device_uid : "unknown");
      reportError(new Error(`device.auth_rejected_${reason} device=${scope}`), {
        severity: "warning",
        route: "device-auth",
      });
    }
  }
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

  // ── Resolve signing keys ────────────────────────────────────────────────
  // enc mode: decrypt the stored ciphertext (KEK-wrapped, AAD=device.id) and
  // derive sha256(secret) transiently — the hash column is NOT used as the
  // key. legacy mode: pre-v2 rows have no enc; hash-as-key until rotation.
  // A pending rotation slot (device_secret_enc_next, unexpired) is ALSO
  // resolved up front so both credentials are always evaluated — no timing
  // oracle on which slot matched.
  const provided = req.signature.trim().toLowerCase();
  const sigShapeOk = /^[0-9a-f]{64}$/.test(provided);
  const signedMessage = `${req.timestamp}.${req.body}`;
  const sigMatches = (key: string | null) =>
    !!key && sigShapeOk && safeEqHex(hmacHex(key, signedMessage), provided);

  let primaryKey: string | null = null;
  let primaryKeyVersion = "none";
  if (device.device_secret_enc) {
    try {
      const d = decryptSecretAny(device.device_secret_enc, device.id);
      primaryKey = deviceSecretHash(d.secret);
      primaryKeyVersion = d.keyVersion;
    } catch {
      primaryKey = null; // undecryptable primary — handled below (503 unless next saves it)
    }
  } else if (device.device_secret_hash) {
    primaryKey = device.device_secret_hash;
    primaryKeyVersion = "legacy_hash";
  }

  const nextEnc = device.device_secret_enc_next ?? null;
  const nextExpMs = device.credential_next_expires_at ? Date.parse(device.credential_next_expires_at) : NaN;
  const nextActive = !!nextEnc && Number.isFinite(nextExpMs) && nextExpMs > now.getTime();
  let nextKey: string | null = null;
  let nextSecret: string | null = null;
  let nextKeyVersion = "none";
  if (nextActive && nextEnc) {
    try {
      const d = decryptSecretAny(nextEnc, device.id);
      nextSecret = d.secret;
      nextKey = deviceSecretHash(d.secret);
      nextKeyVersion = d.keyVersion;
    } catch {
      nextKey = null; // corrupt/undecryptable next slot never widens access
    }
  }

  let matched: "primary" | "next" | null = null;
  let keyMode: "enc" | "legacy_hash" = device.device_secret_enc ? "enc" : "legacy_hash";
  let keyVersion = primaryKeyVersion;
  if (sigMatches(primaryKey)) {
    matched = "primary";
  } else if (sigMatches(nextKey)) {
    matched = "next";
    keyMode = "enc"; // the staged credential is always enc-mode
    keyVersion = nextKeyVersion;
  }

  if (!matched) {
    // An undecryptable PRIMARY is an integrity/server fault → 503, even when a
    // next slot exists but also failed to match.
    if (device.device_secret_enc && primaryKey == null) {
      return reject(503, "Device credential cannot be decrypted (KEK missing or ciphertext corrupt)", "key_decrypt_failed");
    }
    return reject(401, "Invalid signature", "bad_signature");
  }

  // First successful auth with the staged credential promotes it to primary —
  // the zero-downtime rotation completes here, audited.
  let rotationPromoted = false;
  if (matched === "next" && nextEnc && nextSecret) {
    rotationPromoted = await promoteCredentialRotation(db, device, nextEnc, nextSecret, nextKeyVersion, now);
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
    detail: { device_uid: device.device_uid, key_mode: keyMode, key_version: keyVersion, dedup: "claim", ...(rotationPromoted ? { rotation: "promoted" } : {}) },
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
    detail: { device_uid: device.device_uid, message_type: "ingest", key_mode: keyMode, key_version: keyVersion, ...(rotationPromoted ? { rotation: "promoted" } : {}) },
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
