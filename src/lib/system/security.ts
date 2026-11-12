import type { SupabaseClient } from "@supabase/supabase-js";
import { SYSTEM_ROLES, type SystemRole } from "./rbac";
import { systemAudit, type ChangeRisk, type SystemActor } from "./audit";

/**
 * Technical user administration for system.zapnivo.com.
 *
 * Scope: profiles.system_role (the separate system-access tier) and which
 * profiles carry staff business roles. Business roles themselves are managed
 * in the business admin portal — this module never touches profiles.role.
 *
 * Session metadata comes from auth_sessions (migration 0028): absolute 24h
 * lifetime anchored at first-seen auth. We expose metadata only — session_key
 * prefixes and timestamps; there are no tokens to leak.
 */

export type SystemUserRow = {
  id: string;
  email: string;
  full_name: string | null;
  business_role: string;
  system_role: SystemRole | null;
  mfa_required: boolean;
  /** profiles.system_suspended (0043) — suspended users keep the role but lose access. */
  suspended: boolean;
  created_at: string;
};

/**
 * Users relevant to the system plane: anyone with a system_role, plus staff
 * business roles (admin/staff) who may be candidates for a grant.
 */
export async function listSystemUsers(db: SupabaseClient): Promise<SystemUserRow[]> {
  const { data, error } = await db
    .from("profiles")
    .select("id,email,full_name,role,system_role,mfa_required,system_suspended,created_at")
    .or("system_role.not.is.null,role.in.(admin,staff)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return [];
  return ((data ?? []) as {
    id: string; email: string; full_name: string | null; role: string;
    system_role: string | null; mfa_required: boolean; system_suspended: boolean | null; created_at: string;
  }[]).map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    business_role: p.role,
    system_role: (SYSTEM_ROLES as readonly string[]).includes(p.system_role ?? "") ? (p.system_role as SystemRole) : null,
    mfa_required: p.mfa_required === true,
    suspended: p.system_suspended === true,
    created_at: p.created_at,
  }));
}

export type RoleChangeResult =
  | { ok: true; user: SystemUserRow }
  | { ok: false; status: number; error: string };

/**
 * Change-request risk for a system_role grant/revoke. 'breakglass' AND
 * 'sysadmin' are high-risk: they require an approved change request decided
 * by a different principal before the mutation executes (route enforces via
 * assertApprovedOrRequest; this helper keeps the policy in one place).
 */
export function roleGrantRisk(role: SystemRole | null): ChangeRisk {
  return role === "breakglass" || role === "sysadmin" ? "high" : "medium";
}

/**
 * Grants or revokes a system_role. `newRole = null` revokes.
 * Caller (route) must have already enforced: system.users.manage permission,
 * actor ≠ target, and approval gate for breakglass grants / breakglass actors.
 */
export async function setSystemRole(
  db: SupabaseClient,
  actor: SystemActor,
  targetUserId: string,
  newRole: SystemRole | null,
): Promise<RoleChangeResult> {
  const { data: target, error: readErr } = await db
    .from("profiles")
    .select("id,email,full_name,role,system_role,mfa_required,system_suspended,created_at")
    .eq("id", targetUserId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!target) return { ok: false, status: 404, error: "User not found" };
  const t = target as { id: string; email: string; full_name: string | null; role: string; system_role: string | null; mfa_required: boolean; system_suspended: boolean | null; created_at: string };

  const { error: upErr } = await db
    .from("profiles")
    .update({ system_role: newRole })
    .eq("id", targetUserId);
  if (upErr) return { ok: false, status: 500, error: upErr.message };

  await systemAudit(db, {
    actor,
    action: newRole ? "system_role.granted" : "system_role.revoked",
    resource: `profile:${targetUserId}`,
    detail: { target_email: t.email, from: t.system_role, to: newRole },
  });

  return {
    ok: true,
    user: {
      id: t.id, email: t.email, full_name: t.full_name, business_role: t.role,
      system_role: newRole, mfa_required: t.mfa_required === true,
      suspended: t.system_suspended === true, created_at: t.created_at,
    },
  };
}

/* ─── Sessions ─────────────────────────────────────────────────────────── */

export type SessionRow = {
  session_key: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  system_role: string | null;
  auth_method: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  expired: boolean;
  active: boolean;
};

/**
 * Session registry metadata. session_key is stored truncated to its prefix
 * ('sso' / 'anchor') — the raw key is a lookup handle, not a credential, but we
 * still minimize exposure. No tokens exist in this table by design.
 */
export async function listSessions(db: SupabaseClient, opts: { limit?: number; includeExpired?: boolean } = {}): Promise<SessionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  let q = db
    .from("auth_sessions")
    .select("session_key,user_id,auth_method,created_at,last_seen_at,expires_at,revoked_at")
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (!opts.includeExpired) q = q.is("revoked_at", null).gt("expires_at", new Date().toISOString());
  const { data, error } = await q;
  if (error) return [];
  const rows = (data ?? []) as { session_key: string; user_id: string; auth_method: string | null; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null }[];
  if (!rows.length) return [];

  const ids = [...new Set(rows.map((r) => r.user_id))];
  const { data: profiles } = await db.from("profiles").select("id,email,full_name,system_role").in("id", ids);
  const byId = new Map(
    ((profiles ?? []) as { id: string; email: string; full_name: string | null; system_role: string | null }[]).map((p) => [p.id, p]),
  );
  const now = Date.now();
  return rows.map((r) => {
    const p = byId.get(r.user_id);
    const expired = Date.parse(r.expires_at) <= now;
    return {
      session_key: r.session_key.split(":")[0] ?? "unknown",
      user_id: r.user_id,
      email: p?.email ?? null,
      full_name: p?.full_name ?? null,
      system_role: p?.system_role ?? null,
      auth_method: r.auth_method,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      expired,
      active: !r.revoked_at && !expired,
    };
  });
}
