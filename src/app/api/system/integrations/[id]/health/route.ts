import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { checkIntegrationHealth, getProvider } from "@/lib/system/integrations";
import { systemAudit } from "@/lib/system/audit";
import { verifyProviderConnection, DEPLOY_PROVIDERS, type DeployProviderId } from "@/lib/system/deploy-verify";

/**
 * GET /api/system/integrations/[id]/health — one bounded (5s), read-only live
 * check. Only providers with an existing API client in this repo are called;
 * others return unconfigured / requires_credentials / not_verified honestly.
 * Audited as a sensitive read.
 *
 * For deploy providers (github, vercel) the response additionally carries a
 * `verification` object from deploy-verify: granted scopes / token identity /
 * write-capability honesty. The verification performs its own read-only
 * probes and writes its own 'integration.health_checked' audit row (which is
 * emitted AFTER the health audit below so it becomes the newest row — the
 * integrations registry then surfaces the richer scope detail).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.integrations.view", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!getProvider(id)) return NextResponse.json({ error: "Unknown integration" }, { status: 404 });

  const health = await checkIntegrationHealth(id, g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "integration.health_checked",
    resource: `integration:${id}`,
    detail: { status: health?.status, latencyMs: health?.latencyMs, detail: health?.detail?.slice(0, 200) ?? null },
  });

  let verification = null;
  if ((DEPLOY_PROVIDERS as readonly string[]).includes(id)) {
    verification = await verifyProviderConnection(
      g.db,
      { id: g.user.id, role: g.role },
      id as DeployProviderId,
      { force: true },
    );
  }
  return NextResponse.json({ health, verification });
}
