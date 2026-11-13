import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { getDeploymentPipeline } from "@/lib/system/deploy-pipeline";

/**
 * GET /api/system/deployments/[id]/pipeline — derived deployment pipeline
 * stages for one deployment. Perm: system.deployments.view.
 *
 * `id` may be a deployment-request UUID or a Vercel deployment uid. Evidence
 * comes from the request row (status/result jsonb), a single read-only
 * provider GET when Vercel is configured, and stored monitor/health/profile
 * snapshots. Stages with no evidence report 'unknown'/'skipped' — the
 * pipeline never fabricates progress.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{4,100}$|^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const pipeline = await getDeploymentPipeline(g.db, id);
  if (!pipeline) {
    return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
  }
  return NextResponse.json(pipeline);
}
