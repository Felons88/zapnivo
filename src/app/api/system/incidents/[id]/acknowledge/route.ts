import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { acknowledgeIncident } from "@/lib/system/incidents";
import { roleCan } from "@/lib/system/rbac";

const bodySchema = z.object({
  justification: z.string().trim().max(500).optional(),
});

/**
 * POST /api/system/incidents/[id]/acknowledge — stamps acknowledged_at.
 *
 * No dedicated incident permission exists in SYSTEM_PERMISSIONS, so the
 * mutation requires BOTH system.security.audit.view (incident context) and
 * system.changes.request (a real mutation perm held by hardware/engineer/
 * security/sysadmin/breakglass). Viewers and developers are read-only.
 * Breakglass actors still need an approved change request (risk: low) via
 * assertApprovedOrRequest inside acknowledgeIncident.
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
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 422 });

  const result = await acknowledgeIncident(g.db, { id: g.user.id, role: g.role }, id, parsed.data.justification);
  if (!result.ok) {
    const status = result.status === 202 ? 202 : result.status;
    return NextResponse.json({ error: result.error, reason: result.reason }, { status });
  }
  return NextResponse.json({
    ok: true,
    alreadyAcknowledged: result.alreadyAcknowledged,
    changeRequestId: result.changeRequestId,
    incident: result.incident,
  });
}
