import { NextResponse } from "next/server";
import { systemApiGuard, readJson } from "../../../_shared";
import { isIncidentStatus, transitionIncident, transitionSchema } from "@/lib/system/incidents";
import { roleCan } from "@/lib/system/rbac";

/**
 * POST /api/system/incidents/[id]/transition — lifecycle transition.
 * Body: { to_status, reason? }. 'reopened' requires reason.
 *
 * Same permission model as acknowledge: reads need system.security.audit.view,
 * mutations additionally need system.changes.request. Illegal edges → 409,
 * missing reopen reason → 422, breakglass → 202 pending change request.
 * Writes system_incident_events + system_audit_events.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 30 });
  if (!g.ok) return g.res;
  if (!roleCan(g.role, "system.changes.request")) {
    return NextResponse.json({ error: "Missing permission: system.changes.request (incident mutations)" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 });

  const raw = await readJson(req);
  const parsed = transitionSchema.safeParse(raw ?? {});
  if (!parsed.success || !isIncidentStatus(parsed.data.to_status)) {
    return NextResponse.json({ error: "Invalid body — expected { to_status, reason? }" }, { status: 422 });
  }

  const result = await transitionIncident(
    g.db,
    { id: g.user.id, role: g.role },
    id,
    parsed.data.to_status,
    parsed.data.reason,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, reason: result.reason, allowed: result.allowed ?? null },
      { status: result.status === 202 ? 202 : result.status },
    );
  }
  return NextResponse.json({ ok: true, incident: result.incident, event: result.event, changeRequestId: result.changeRequestId });
}
