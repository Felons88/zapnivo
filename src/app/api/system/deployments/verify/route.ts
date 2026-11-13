import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { verifyProviderConnection, DEPLOY_PROVIDERS, type DeployProviderId } from "@/lib/system/deploy-verify";

/**
 * GET /api/system/deployments/verify?provider=vercel|github — run (or return
 * the cached) read-only connection check for a deploy provider.
 * Perm: system.deployments.view. Results are cached ~5min in module memory;
 * every REAL check is audited as 'integration.health_checked'.
 * `?force=1` bypasses the cache.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.deployments.view", { limit: 60 });
  if (!g.ok) return g.res;

  const provider = new URL(req.url).searchParams.get("provider") as DeployProviderId | null;
  if (!provider || !(DEPLOY_PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json({ error: `provider must be one of: ${DEPLOY_PROVIDERS.join(", ")}` }, { status: 400 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  const verification = await verifyProviderConnection(
    g.db,
    { id: g.user.id, role: g.role },
    provider,
    { force },
  );
  return NextResponse.json({ verification });
}
