import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { systemAudit, type SystemActor } from "./audit";
import { issueDeviceCredential, type DeviceAuthRow } from "./device-auth";
import { deviceAuditResource, provisionTokenHash, type SystemDeviceStatus } from "./kiosks";

/**
 * Secure kiosk provisioning-token redemption (POST /api/devices/provision).
 *
 * The provisioning token (`znk_…`, issued once by staff via
 * /api/system/kiosks/[id]/provision) IS the credential — there is no session.
 * Redemption is single-use and race-safe:
 *
 *   1. sha256(token) → lookup system_devices.provision_token_hash.
 *   2. Validate existence / unused / unexpired / provisionable status / optional
 *      device binding (device_uid, serial_number, gateway).
 *   3. ATOMIC CLAIM: `UPDATE … SET provision_token_used_at=now()
 *      WHERE id=? AND provision_token_used_at IS NULL`. Under Postgres read-
 *      committed semantics a concurrent second claim blocks on the row lock,
 *      re-evaluates the predicate, and matches 0 rows → 409 already_consumed.
 *      This — not a check-then-set — is what makes single-use safe.
 *   4. issueDeviceCredential mints the per-device HMAC credential. Ordering is
 *      claim-FIRST on purpose: issuing before claiming would let a replayed
 *      token mint unlimited credentials. If issuance FAILS after a successful
 *      claim, a compensating write clears provision_token_used_at back to NULL
 *      (best-effort) so the token is redeemable again — the alternative
 *      (consumed-but-credentialless) would strand the device until staff
 *      re-issue. The failure is audited as kiosk.provisioning_failed.
 *
 * The device is NEVER moved to 'active' here — issueDeviceCredential only
 * advances status along a legal lifecycle edge (→ 'provisioning'). 'active'
 * additionally requires authenticated telemetry: verifyDeviceAuth only accepts
 * status active|testing, and the staff lifecycle/testing flow owns that move.
 *
 * Secrets: the raw token and the issued secret are NEVER logged, audited, or
 * persisted — only sha256(token) is stored, and audit detail carries device
 * ids/uids + timestamps only (systemAudit additionally scrubs secret-looking
 * keys).
 */

export const provisionRedeemSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^znk_[A-Za-z0-9_-]{20,64}$/, "invalid provisioning token"),
    device_uid: z.string().trim().min(1).max(120).optional(),
    serial_number: z.string().trim().min(1).max(120).optional(),
    gateway_id: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ProvisionRedeemInput = z.infer<typeof provisionRedeemSchema>;

/** Columns needed for lookup + validation + issueDeviceCredential. */
const PROVISION_SELECT =
  "id,device_uid,serial_number,gateway,status,auth_method,device_secret_hash,device_secret_enc,device_secret_enc_next,credential_next_expires_at,credential_rotated_at,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts,provision_token_hash,provision_token_expires_at,provision_token_used_at";

export type ProvisionableDevice = DeviceAuthRow & {
  gateway: string | null;
  provision_token_hash: string | null;
  provision_token_expires_at: string | null;
  provision_token_used_at: string | null;
};

/**
 * Statuses from which provisioning-token redemption is meaningful. Mirrors the
 * DEVICE_TRANSITIONS edges into 'provisioning' (registered/testing/suspended)
 * plus 'provisioning' itself (credential re-issue while already provisioning)
 * and 'pending' (registered-but-not-yet-placed hardware completing setup).
 * 'active'/'maintenance' devices must rotate credentials via the staff
 * credential endpoints (elevation-gated); 'quarantined'/'decommissioned' are
 * refused by issueDeviceCredential anyway — denying here keeps the token from
 * being burned on a device that can never accept it.
 */
export const PROVISIONABLE_STATUSES: readonly SystemDeviceStatus[] = [
  "pending",
  "registered",
  "provisioning",
  "testing",
  "suspended",
];

/** Honest system actor for machine-initiated credential issuance. */
export const PROVISIONING_ACTOR: SystemActor = { id: "device-provisioning", role: "system" };

export type ProvisionRedeemOk = {
  ok: true;
  device: ProvisionableDevice;
  /** Raw device secret — returned to the caller ONCE, never persisted/logged. */
  secret: string;
  expiresAt: string;
};
export type ProvisionRedeemFail = { ok: false; status: number; error: string; code: string };
export type ProvisionRedeemResult = ProvisionRedeemOk | ProvisionRedeemFail;

const UNKNOWN_RESOURCE = "system_device:unknown";

export async function redeemProvisionToken(
  db: SupabaseClient,
  input: ProvisionRedeemInput,
  now = new Date(),
): Promise<ProvisionRedeemResult> {
  const fail = async (
    status: number,
    error: string,
    code: string,
    device: ProvisionableDevice | null = null,
    auditAction: "kiosk.provisioning_denied" | "kiosk.provisioning_failed" = "kiosk.provisioning_denied",
  ): Promise<ProvisionRedeemFail> => {
    await systemAudit(db, {
      actor: PROVISIONING_ACTOR,
      action: auditAction,
      resource: device ? deviceAuditResource(device.id) : UNKNOWN_RESOURCE,
      // `reason` values are coarse codes only — never the token, its hash, or
      // oracle-grade detail beyond expired-vs-invalid (both are safe to reveal
      // to whoever holds the high-entropy token).
      detail: { reason: code, device_uid: device?.device_uid ?? null },
    });
    return { ok: false, status, error, code };
  };

  // ── 1–2. Hash lookup + cheap validation ─────────────────────────────────
  const hash = provisionTokenHash(input.token);
  const { data: row, error: lookupErr } = await db
    .from("system_devices")
    .select(PROVISION_SELECT)
    .eq("provision_token_hash", hash)
    .maybeSingle();
  if (lookupErr) return fail(503, "Provisioning lookup failed", "lookup_failed", null, "kiosk.provisioning_failed");
  const device = (row ?? null) as ProvisionableDevice | null;
  if (!device || !device.provision_token_hash) {
    return fail(401, "Invalid provisioning token", "invalid_token");
  }
  if (device.provision_token_used_at) {
    return fail(409, "Provisioning token already used", "already_consumed", device);
  }
  const expMs = device.provision_token_expires_at ? Date.parse(device.provision_token_expires_at) : NaN;
  if (!Number.isFinite(expMs) || expMs < now.getTime()) {
    return fail(403, "Provisioning token expired", "token_expired", device);
  }
  if (!PROVISIONABLE_STATUSES.includes(device.status as SystemDeviceStatus)) {
    return fail(409, `Device status '${device.status}' cannot be provisioned`, "device_not_provisionable", device);
  }

  // ── 3. Optional device binding — supplied identifiers must match the row. ──
  if (input.device_uid != null && device.device_uid !== input.device_uid) {
    return fail(403, "device_uid does not match this provisioning token", "binding_mismatch", device);
  }
  if (input.serial_number != null && device.serial_number !== input.serial_number) {
    return fail(403, "serial_number does not match this provisioning token", "binding_mismatch", device);
  }
  // gateway_id binds only when the row actually records a gateway; a NULL
  // gateway on the device row means there is nothing to verify against.
  if (input.gateway_id != null && device.gateway != null && device.gateway !== input.gateway_id) {
    return fail(403, "gateway_id does not match this provisioning token", "binding_mismatch", device);
  }

  // ── 4. Atomic single-use claim (race-safe) ───────────────────────────────
  const nowIso = now.toISOString();
  const { data: claimed, error: claimErr } = await db
    .from("system_devices")
    .update({ provision_token_used_at: nowIso, updated_at: nowIso })
    .eq("id", device.id)
    .is("provision_token_used_at", null)
    .select("id")
    .maybeSingle();
  if (claimErr) return fail(503, "Provisioning claim failed", "claim_failed", device, "kiosk.provisioning_failed");
  if (!claimed) {
    // Lost the race (or token was consumed between lookup and claim).
    return fail(409, "Provisioning token already used", "already_consumed", device);
  }

  // ── 5. Issue the per-device HMAC credential (secret returned once). ──────
  const issued = await issueDeviceCredential(db, device, PROVISIONING_ACTOR);
  if (!issued.ok) {
    // Compensating write: release the claim so the token can be retried —
    // better a retryable token than a device stuck credentialless. Best-effort:
    // if THIS write also fails the token stays consumed and staff must re-issue
    // (issueProvisionToken resets used_at on re-issue — recovery path exists).
    try {
      await db
        .from("system_devices")
        .update({ provision_token_used_at: null, updated_at: new Date().toISOString() })
        .eq("id", device.id);
    } catch { /* best-effort compensation */ }
    await systemAudit(db, {
      actor: PROVISIONING_ACTOR,
      action: "kiosk.provisioning_failed",
      resource: deviceAuditResource(device.id),
      detail: {
        reason: "credential_issuance_failed",
        device_uid: device.device_uid,
        issuance_status: issued.status,
        claim_released: true,
      },
    });
    return { ok: false, status: 503, error: "Credential issuance failed — provisioning token released for retry", code: "issuance_failed" };
  }

  // ── 6. Success audit — ids/uids/timestamps only, never token or secret. ──
  await systemAudit(db, {
    actor: PROVISIONING_ACTOR,
    action: "kiosk.provisioning_redeemed",
    resource: deviceAuditResource(device.id),
    detail: {
      device_uid: device.device_uid,
      serial_number: device.serial_number,
      auth_method: "hmac_sha256",
      credential_expires_at: issued.expiresAt,
    },
  });

  return { ok: true, device, secret: issued.secret, expiresAt: issued.expiresAt };
}
