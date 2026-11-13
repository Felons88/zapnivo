import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getDeploymentDetail, githubCommitUrl, probeableUrl } from "@/lib/system/deploy-center";
import { githubGate } from "@/lib/system/deploy-provider";

/**
 * GET /api/system/deployments/[id] — deployment detail.
 * `id` may be a Vercel deployment uid (dpl_…) or a deployment-request UUID.
 * Build events are included when VERCEL_TOKEN+VERCEL_PROJECT_ID are configured;
 * otherwise eventsStatus reports 'requires_credentials' honestly.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{4,100}$|^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const detail = await getDeploymentDetail(g.db, id);
  if (!detail) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const commitUrl = detail.deployment?.commitSha ? githubCommitUrl(detail.deployment.commitSha) : null;
  const github = githubGate();

  return NextResponse.json({
    ...detail,
    commitUrl,
    providers: {
      vercel: { configured: Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID) },
      github: { configured: github.configured, missing: github.missing },
    },
    probeableUrl: detail.deployment?.url ? probeableUrl(`https://${detail.deployment.url}`) : null,
  });
}
