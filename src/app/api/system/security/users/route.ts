import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { listSystemUsers, setSystemRole } from "@/lib/system/security";
import { assertApprovedOrRequest } from "@/lib/system/audit";
import { SYSTEM_ROLES } from "@/lib/system/rbac";

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

/**
 * POST /api/system/security/users — grant a system_role (system.users.manage).
 * Rules enforced here:
 *  - actor can never modify their own system_role (separation of duties)
 *  - granting 'breakglass' is risk=high → requires an approved change request
 *    decided by a different principal (assertApprovedOrRequest)
 *  - breakglass actors: every mutation needs an approved change request
 * All changes write a system_audit_events row.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.users.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = grantSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  if (parsed.data.user_id === g.user.id) {
    return NextResponse.json({ error: "You cannot modify your own system role" }, { status: 403 });
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `system_role.grant:${parsed.data.system_role}`,
    risk: parsed.data.system_role === "breakglass" ? "high" : "medium",
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
 * Same self-modification and approval rules as grant.
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

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: "system_role.revoke",
    risk: "medium",
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
