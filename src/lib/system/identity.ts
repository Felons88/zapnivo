import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, type SystemActor } from "./audit";
import { hasVerifiedTotp, type MfaConfig } from "./mfa";

/**
 * Identity lifecycle helpers for the system plane (migration 0043):
 *  - one-time privileged bootstrap (env-token gated sysadmin grant)
 *  - technical-user suspension (profiles.system_suspended)
 *  - session revocation via the auth_sessions registry
 *
 * Pure/testable: no next/headers imports — routes extract the session token
 * and pass it in. All mutations write system_audit_events rows.
 */

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

export const BOOTSTRAP_TOKEN_ENV = "SYSTEM_BOOTSTRAP_TOKEN";

export const bootstrapConfigured = () => Boolean(process.env[BOOTSTRAP_TOKEN_ENV]);

/** Constant-time token comparison. Never logs either side. */
export function bootstrapTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export type BootstrapInput = {
  /** The SYSTEM_BOOTSTRAP_TOKEN value presented by the operator. */
  token: string;
  /** Must equal the session user's email (case-insensitive). */
  confirmEmail: string;
  /** Caller's Supabase access token — used ONLY to check verified TOTP factors. */
  accessToken: string;
};

export type BootstrapResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: string };

export type BootstrapDeps = {
  config?: MfaConfig | null;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

/**
 * One-time privileged bootstrap. Grants profiles.system_role='sysadmin' to a
 * signed-in user who holds NO system role yet. Requirements, in order:
 *   1. SYSTEM_BOOTSTRAP_TOKEN env is set and the presented token matches
 *   2. confirm_email matches the session email
 *   3. the user has a VERIFIED TOTP factor in Supabase Auth MFA
 *   4. profiles.system_role is still NULL (never overwrites an existing role)
 *   5. no prior system_bootstrap_grants row exists for this profile (replay)
 * On success: sets system_role, inserts the grant row (consumed_at set — the
 * grant is spent immediately), audits 'system.bootstrap.grant'.
 */
export async function attemptBootstrap(
  db: SupabaseClient | null | undefined,
  user: SessionUser | null,
  input: BootstrapInput,
  deps: BootstrapDeps = {},
): Promise<BootstrapResult> {
  if (!user) return { ok: false, status: 401, error: "Unauthenticated" };
  const expected = process.env[BOOTSTRAP_TOKEN_ENV];
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "bootstrap_not_configured",
      code: "bootstrap_not_configured",
    };
  }
  if (!input.token || !bootstrapTokenMatches(input.token, expected)) {
    return { ok: false, status: 403, error: "Invalid bootstrap token" };
  }
  if (!input.confirmEmail || input.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return { ok: false, status: 400, error: "confirm_email must match your signed-in email" };
  }
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };

  // MFA gate — a verified TOTP factor must exist before privilege is granted.
  const mfa = await hasVerifiedTotp(input.accessToken, { config: deps.config, fetchImpl: deps.fetchImpl });
  if (!mfa.ok) {
    return { ok: false, status: 502, error: `MFA check failed: ${mfa.error.message}` };
  }
  if (!mfa.verified) {
    return {
      ok: false,
      status: 403,
      error: "mfa_enrollment_required",
      code: "mfa_enrollment_required",
    };
  }

  // Replay gate — one bootstrap grant per profile, ever.
  const { data: prior } = await db
    .from("system_bootstrap_grants")
    .select("id")
    .eq("profile_id", user.id)
    .limit(1);
  if (Array.isArray(prior) && prior.length > 0) {
    return { ok: false, status: 409, error: "Bootstrap already consumed for this account" };
  }

  // Role gate — only fill a NULL system_role; never overwrite.
  const { data: profile, error: readErr } = await db
    .from("profiles")
    .select("id,system_role")
    .eq("id", user.id)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  const currentRole = (profile as { system_role?: string | null } | null)?.system_role ?? null;
  if (currentRole !== null) {
    return { ok: false, status: 409, error: "Account already holds a system role — bootstrap is not needed" };
  }

  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();
  const { data: updated, error: upErr } = await db
    .from("profiles")
    .update({ system_role: "sysadmin" })
    .eq("id", user.id)
    .is("system_role", null)
    .select("id")
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  if (!updated) {
    return { ok: false, status: 409, error: "system_role changed concurrently — bootstrap aborted" };
  }

  const { error: grantErr } = await db.from("system_bootstrap_grants").insert({
    profile_id: user.id,
    granted_by: `bootstrap:${user.email}`,
    method: "totp",
    created_at: nowIso,
    consumed_at: nowIso, // spent immediately — replay impossible
  });
  if (grantErr) {
    // Unique-violation on system_bootstrap_grants_single means a concurrent
    // bootstrap already consumed the single global grant — revert the role we
    // just set so no second administrator survives the race.
    const isUnique = (grantErr as { code?: string }).code === "23505";
    if (isUnique) {
      await db.from("profiles").update({ system_role: null }).eq("id", user.id).eq("system_role", "sysadmin");
      return { ok: false, status: 409, error: "Bootstrap already consumed — only one privileged grant is permitted" };
    }
    // Role was granted but the audit row failed — still audit the grant itself.
    await systemAudit(db, {
      actor: { id: user.id, role: "sysadmin" },
      action: "system.bootstrap.grant",
      resource: `profile:${user.id}`,
      detail: { grant_row_error: true },
    });
    return { ok: false, status: 500, error: `Grant recorded but bootstrap audit insert failed: ${grantErr.message}` };
  }

  await systemAudit(db, {
    actor: { id: user.id, role: "sysadmin" },
    action: "system.bootstrap.grant",
    resource: `profile:${user.id}`,
    detail: { method: "totp", granted_by: "env_token" },
  });
  return { ok: true };
}

/* ── Suspension ─────────────────────────────────────────────────────────── */

export type IdentityResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Sets profiles.system_suspended. A suspended user keeps their business role
 * but systemRole() returns null → all system-plane access is denied even
 * though system_role remains set (reversible without losing the grant).
 * Self-suspension is refused. Audited.
 */
export async function setSystemSuspended(
  db: SupabaseClient | null | undefined,
  actor: SystemActor,
  targetUserId: string,
  suspended: boolean,
): Promise<IdentityResult> {
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  if (targetUserId === actor.id) {
    return { ok: false, status: 403, error: "You cannot suspend or unsuspend your own account" };
  }
  const { data: target, error: readErr } = await db
    .from("profiles")
    .select("id,email,system_suspended")
    .eq("id", targetUserId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!target) return { ok: false, status: 404, error: "User not found" };

  const { error: upErr } = await db
    .from("profiles")
    .update({ system_suspended: suspended })
    .eq("id", targetUserId);
  if (upErr) return { ok: false, status: 500, error: upErr.message };

  await systemAudit(db, {
    actor,
    action: suspended ? "system_user.suspended" : "system_user.unsuspended",
    resource: `profile:${targetUserId}`,
    detail: { target_email: (target as { email?: string }).email ?? null },
  });
  return { ok: true };
}

/* ── Session revocation ─────────────────────────────────────────────────── */

/**
 * Revokes auth_sessions rows for a user — either one specific session_key or
 * all of the user's sessions. Rows are hard-deleted (they are a session
 * registry, not an audit trail; the audit event below is the record).
 * Self-revocation of ALL sessions is refused; revoking a single named session
 * is allowed (e.g. a lost device) — callers should still prefer self-service
 * logout for that.
 */
export async function revokeUserSessions(
  db: SupabaseClient | null | undefined,
  actor: SystemActor,
  targetUserId: string,
  opts: { sessionKey?: string } = {},
): Promise<IdentityResult & { revoked?: number }> {
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  if (!opts.sessionKey && targetUserId === actor.id) {
    return { ok: false, status: 403, error: "Use logout to end your own sessions" };
  }
  let q = db.from("auth_sessions").delete().eq("user_id", targetUserId);
  if (opts.sessionKey) q = q.eq("session_key", opts.sessionKey);
  const { data, error } = await q.select("session_key");
  if (error) return { ok: false, status: 500, error: error.message };
  const count = Array.isArray(data) ? data.length : 0;
  await systemAudit(db, {
    actor,
    action: opts.sessionKey ? "session.revoked" : "session.revoked_all",
    resource: `profile:${targetUserId}`,
    detail: { count, session_key: opts.sessionKey ?? null },
  });
  return { ok: true, revoked: count };
}
