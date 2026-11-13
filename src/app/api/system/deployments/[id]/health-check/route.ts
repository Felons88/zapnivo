import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { checkDeploymentHealthNow } from "@/lib/system/deploy-center";

/**
 * POST /api/system/deployments/[id]/health-check — explicit health probe.
 * Perm: system.deployments.view (read-only network probe; result.health is
 * refreshed and 'deployment.health_checked' is always audited).
 * `id` must be a deployment-request UUID with a provider_deployment_id.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const result = await checkDeploymentHealthNow(g.db, { id: g.user.id, role: g.role }, id);
  if (!result.ok) {
    const status = result.error === "Deployment request not found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
