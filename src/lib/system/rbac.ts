import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { devAuth, type SessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

/**
 * System control plane RBAC (system.zapnivo.com).
 *
 * Access is a SEPARATE tier from profiles.role: only profiles.system_role grants
 * entry, and it is never auto-assigned — business admin/staff have NULL and are
 * denied. Permission strings are code-defined here; the DB stores only the role.
 *
 * Roles (see migration 0042):
 *   viewer      — read-only observability/audit/flags visibility
 *   developer   — app surfaces: flags, webhooks, deployments (non-prod), AI config view
 *   hardware    — kiosk/device fleet: devices, commands, provisioning metadata
 *   engineer    — deployments + database schema + integrations (incl. flag toggles)
 *   security    — audit, secrets rotation requests, user management view, change decisions
 *   sysadmin    — everything
 *   breakglass  — everything EXCEPT system.emergency.approve, BUT every mutation
 *                 requires an approved change request (separation of duties:
 *                 the approver must be a different principal)
 *
 * Emergency tier (system.emergency.*): view → every role; request →
 * developer/engineer/hardware/security/sysadmin/breakglass; execute →
 * security/sysadmin/breakglass; approve → sysadmin/security ONLY (breakglass
 * can never approve — dual-control separation of duties).
 */

export const SYSTEM_ROLES = ["viewer", "developer", "hardware", "engineer", "security", "sysadmin", "breakglass"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];
export const isSystemRole = (v: unknown): v is SystemRole => typeof v === "string" && (SYSTEM_ROLES as readonly string[]).includes(v);

export const SYSTEM_PERMISSIONS = [
  "system.dashboard.view",
  "system.kiosks.view",
  "system.kiosks.manage",
  "system.integrations.view",
  "system.integrations.manage",
  "system.secrets.rotate",
  "system.deployments.view",
  "system.deployments.manage",
  "system.database.schema.view",
  "system.webhooks.retry",
  "system.ai.view",
  "system.ai.manage",
  "system.security.audit.view",
  "system.users.manage",
  "system.changes.view",
  "system.changes.request",
  "system.changes.decide",
  "system.flags.view",
  "system.flags.manage",
  "system.emergency.view",
  "system.emergency.request",
  "system.emergency.execute",
  "system.emergency.approve",
] as const;
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];

const ALL: readonly SystemPermission[] = SYSTEM_PERMISSIONS;
const READ_ONLY: readonly SystemPermission[] = [
  "system.dashboard.view",
  "system.kiosks.view",
  "system.integrations.view",
  "system.deployments.view",
  "system.database.schema.view",
  "system.ai.view",
  "system.security.audit.view",
  "system.changes.view",
  "system.flags.view",
  "system.emergency.view",
];

export const ROLE_PERMISSIONS: Record<SystemRole, readonly SystemPermission[]> = {
  viewer: READ_ONLY,
  developer: [
    ...READ_ONLY,
    "system.flags.manage",
    "system.webhooks.retry",
    "system.ai.manage",
    "system.deployments.manage",
    "system.emergency.request",
  ],
  hardware: [
    "system.dashboard.view",
    "system.kiosks.view",
    "system.kiosks.manage",
    "system.integrations.view",
    "system.changes.view",
    "system.changes.request",
    "system.flags.view",
    "system.emergency.view",
    "system.emergency.request",
  ],
  engineer: [
    ...READ_ONLY,
    "system.kiosks.manage",
    "system.integrations.manage",
    "system.deployments.manage",
    "system.database.schema.view",
    "system.webhooks.retry",
    "system.ai.manage",
    "system.flags.manage",
    "system.changes.request",
    "system.emergency.request",
  ],
  security: [
    ...READ_ONLY,
    "system.secrets.rotate",
    "system.users.manage",
    "system.changes.decide",
    "system.changes.request",
    "system.emergency.request",
    "system.emergency.execute",
    "system.emergency.approve",
  ],
  sysadmin: ALL,
  // Breakglass gets every permission EXCEPT system.emergency.approve — the
  // emergency approve tier is reserved for security/sysadmin so the break-glass
  // role can never self-approve an emergency action (separation of duties).
  breakglass: ALL.filter((p) => p !== "system.emergency.approve"),
};

/** Pure permission check — use this in tests and anywhere the role is already known. */
export function roleCan(role: SystemRole | null | undefined, perm: SystemPermission): boolean {
  return !!role && (ROLE_PERMISSIONS[role] as readonly string[]).includes(perm);
}

/**
 * Roles whose EVERY mutation must be covered by an approved change request.
 * (High/critical-risk actions require one for any role — see lib/system/audit.ts.)
 */
export const mutationNeedsApproval = (role: SystemRole | null | undefined) => role === "breakglass";

/**
 * Resolves the caller's system role from profiles.system_role. Returns null for
 * business-only users, missing profiles, and unconfigured backends.
 *
 * DEV ONLY: when HELPDESK_DEV_STORE=1 under `next dev`, SYSTEM_DEV_ROLE can pin a
 * role (e.g. SYSTEM_DEV_ROLE=sysadmin) so the console is reachable without a real
 * profile row. Hard-disabled in production builds via devAuth().
 */
export async function systemRole(user: SessionUser | null, db?: SupabaseClient | null): Promise<SystemRole | null> {
  if (!user) return null;
  if (devAuth()) {
    const forced = process.env.SYSTEM_DEV_ROLE;
    if (isSystemRole(forced)) return forced;
  }
  const client = db === undefined ? serviceClient() : db;
  if (!client) return null;
  try {
    const { data, error } = await client.from("profiles").select("system_role,system_suspended").eq("id", user.id).maybeSingle();
    if (error || !data) return null;
    // Suspended technical users lose ALL system access even with a role set (0043).
    if ((data as { system_suspended?: unknown }).system_suspended === true) return null;
    const role = (data as { system_role?: unknown }).system_role;
    return isSystemRole(role) ? role : null;
  } catch {
    return null;
  }
}

/** Async permission check for a session user (resolves system_role first). */
export async function can(user: SessionUser | null, perm: SystemPermission, db?: SupabaseClient | null): Promise<boolean> {
  const role = await systemRole(user, db);
  return roleCan(role, perm);
}

export type SystemAuthz =
  | { ok: true; user: SessionUser; role: SystemRole }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Pure authorization decision — testable without Next.js request context.
 * `mutation` marks routes that change state: breakglass always needs an approved
 * change request (enforced separately via assertApprovedOrRequest in audit.ts).
 */
export function authorize(user: SessionUser | null, role: SystemRole | null, perm: SystemPermission): SystemAuthz {
  if (!user) return { ok: false, status: 401, error: "Unauthenticated" };
  if (!role) return { ok: false, status: 403, error: "No system access" };
  if (!roleCan(role, perm)) return { ok: false, status: 403, error: `Missing permission: ${perm}` };
  return { ok: true, user, role };
}

export type SystemContext = { ok: true; user: SessionUser; role: SystemRole; db: SupabaseClient };
export type SystemGuard = SystemContext | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Route/page guard: session → system_role → permission → service client.
 * `opts.user`/`opts.db` are injectable for tests; routes omit them.
 */
export async function requireSystem(
  perm: SystemPermission,
  opts: { db?: SupabaseClient | null; user?: SessionUser | null } = {},
): Promise<SystemGuard> {
  const { getSessionUser } = await import("@/lib/auth");
  const user = opts.user !== undefined ? opts.user : await getSessionUser();
  const db = opts.db !== undefined ? opts.db : serviceClient();
  if (!user) return { ok: false, status: 401, error: "Unauthenticated" };
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  const role = await systemRole(user, db);
  const decision = authorize(user, role, perm);
  if (!decision.ok) return decision;
  return { ok: true, user: decision.user, role: decision.role, db };
}

/** Converts a failed SystemAuthz into a JSON response for API routes. */
export function systemAuthzResponse(fail: Extract<SystemAuthz, { ok: false }>): NextResponse {
  return NextResponse.json({ error: fail.error }, { status: fail.status });
}
