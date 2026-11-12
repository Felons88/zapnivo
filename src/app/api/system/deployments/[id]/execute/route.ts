import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { executeDeploymentRequest } from "@/lib/system/deployops";

/**
 * POST /api/system/deployments/[id]/execute — "execute" an APPROVED request.
 * Perm: system.deployments.manage.
 *
 * There is no provider deploy client in this app: this endpoint NEVER calls a
 * deployment API. It validates the request state and returns
 * { status: "awaiting_manual_deploy" } so the operator knows to deploy via
 * git push / the Vercel dashboard and record the outcome manually.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const result = await executeDeploymentRequest(g.db, { id: g.user.id, role: g.role }, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.result);
}
