import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { decideDeploymentRequest } from "@/lib/system/deployops";

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(2000).optional(),
});

/**
 * POST /api/system/deployments/[id]/decision — approve/reject a pending
 * deployment request. Perm: system.deployments.manage (deployment-scoped
 * decision right; security retains the generic system.changes.decide flow).
 * Separation of duties enforced in decideDeploymentRequest: decider ≠ requester.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await readJson(req);
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const result = await decideDeploymentRequest(g.db, { id: g.user.id, role: g.role }, id, parsed.data.decision, parsed.data.note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ request: result.request });
}
