import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { listSystemUsers, setSystemRole, roleGrantRisk } from "@/lib/system/security";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { SYSTEM_ROLES, isSystemRole, type SystemRole } from "@/lib/system/rbac";
import { requireElevation } from "@/lib/system/elevation";
import { setSystemSuspended, revokeUserSessions } from "@/lib/system/identity";
import type { SupabaseClient } from "@supabase/supabase-js";

/** GET /api/system/security/users — system-plane user directory (system.security.audit.view). */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const users = await listSystemUsers(g.db);
  return NextResponse.json({ users });
}

const grantSchema = z.object({
  user_id: z.string().uuid(),
  system_role: z.enum(SYSTEM_ROLES),
  justification: z.string().trim().max(2000).optional(),
});

const revokeSchema = z.object({
  user_id: z.string().uuid(),
  justification: z.string().trim().max(2000).optional(),
});

const actionSchema = z.object({
  action: z.enum(["suspend", "unsuspend", "revoke_sessions"]),
  user_id: z.string().uuid(),
  /** revoke_sessions only: revoke a single session_key instead of all. */
  session_key: z.string().trim().min(3).max(200).optional(),
  justification: z.string().trim().max(2000).optional(),
});

/** 403 helper for missing step-up elevation. */
const stepUpResponse = (error: string) =>
  NextResponse.json({ error, code: "step_up_required" }, { status: 403 });

/** Current system_role of a target profile (null when absent/invalid). */
async function targetSystemRole(db: SupabaseClient, userId: string): Promise<SystemRole | null> {
  const { data } = await db.from("profiles").select("system_role").eq("id", userId).maybeSingle();
  const role = (data as { system_role?: unknown } | null)?.system_role;
  return isSystemRole(role) ? role : null;
}

/**
 * POST /api/system/security/users — grant a system_role OR run a lifecycle
 * action (system.users.manage). Rules enforced here:
 *  - actor can never modify their own system_role / suspension / sessions
 *  - granting 'breakglass' or 'sysadmin' is risk=high → approved change request
 *    decided by a different principal (assertApprovedOrRequest)
 *  - breakglass actors: every mutation needs an approved change request
 *  - suspend/unsuspend/revoke_sessions and grants/revokes of
 *    sysadmin|breakglass additionally require a live step-up elevation
 *    (TOTP verify → 15-min window; 403 {code:'step_up_required'} otherwise)
 * All changes write a system_audit_events row.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.users.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  /* ── Lifecycle actions (suspend / unsuspend / revoke_sessions) ── */
  if (typeof body.action === "string") {
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    const { action, user_id, session_key, justification } = parsed.data;
    if (user_id === g.user.id && action !== "unsuspend") {
      return NextResponse.json({ error: "You cannot modify your own access" }, { status: 403 });
    }
    const elev = await requireElevation(g.db, g.user);
    if (!elev.ok) return stepUpResponse(elev.error);

    const actor = { id: g.user.id, role: g.role };
    const approval = await assertApprovedOrRequest(g.db, actor, {
      action: `system_user.${action}`,
      risk: "high",
      justification: justification ?? `${action} for user ${user_id}`,
    });
    if (approval.status === "pending") {
      return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
    }
    if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

    if (action === "suspend" || action === "unsuspend") {
      const res = await setSystemSuspended(g.db, actor, user_id, action === "suspend");
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      return NextResponse.json({ ok: true, suspended: action === "suspend" });
    }
    const res = await revokeUserSessions(g.db, actor, user_id, { sessionKey: session_key });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true, revoked: res.revoked ?? 0 });
  }

  /* ── Role grant ── */
  const parsed = grantSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  if (parsed.data.user_id === g.user.id) {
    return NextResponse.json({ error: "You cannot modify your own system role" }, { status: 403 });
  }

  // Privileged grants (sysadmin/breakglass) require step-up elevation first.
  if (parsed.data.system_role === "sysadmin" || parsed.data.system_role === "breakglass") {
    const elev = await requireElevation(g.db, g.user);
    if (!elev.ok) return stepUpResponse(elev.error);
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `system_role.grant:${parsed.data.system_role}`,
    risk: roleGrantRisk(parsed.data.system_role),
    justification: parsed.data.justification ?? `Grant system_role '${parsed.data.system_role}'`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setSystemRole(g.db, actor, parsed.data.user_id, parsed.data.system_role);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ user: result.user });
}

/**
 * DELETE /api/system/security/users — revoke a system_role (system.users.manage).
 * Same self-modification, approval and step-up rules as grant; the change risk
 * follows the TARGET's current role (revoking sysadmin/breakglass is high risk).
 */
export async function DELETE(req: Request) {
  const g = await systemApiGuard("system.users.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  if (parsed.data.user_id === g.user.id) {
    return NextResponse.json({ error: "You cannot modify your own system role" }, { status: 403 });
  }

  const currentRole = await targetSystemRole(g.db, parsed.data.user_id);
  if (currentRole === "sysadmin" || currentRole === "breakglass") {
    const elev = await requireElevation(g.db, g.user);
    if (!elev.ok) return stepUpResponse(elev.error);
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: "system_role.revoke",
    risk: roleGrantRisk(currentRole),
    justification: parsed.data.justification ?? "Revoke system_role (set to NULL)",
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setSystemRole(g.db, actor, parsed.data.user_id, null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ user: result.user });
}
