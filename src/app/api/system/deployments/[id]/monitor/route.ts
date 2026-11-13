import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { monitorDeployment, vercelState } from "@/lib/system/deploy-center";
import { getVercelDeployment, vercelConfigured } from "@/lib/system/deploy-provider";

/**
 * GET /api/system/deployments/[id]/monitor — ONE bounded status poll.
 * Perm: system.deployments.view.
 *
 * `id` may be:
 *  - a deployment-request UUID → monitorDeployment(): one provider GET plus
 *    (only when READY + production target) one allowlisted HTTP health probe.
 *    Persists result.provider_monitor / result.health; audits health
 *    transitions as 'deployment.health_checked'.
 *  - a Vercel deployment uid (non-UUID) → live provider state only, no db
 *    writes (used by the detail page's 15s poller).
 *
 * Never blocks: each call performs at most one provider read (+ one probe).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.view", { limit: 240 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{4,100}$|^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  if (isUuid) {
    const outcome = await monitorDeployment(g.db, { id: g.user.id, role: g.role }, id);
    if (!outcome.found) {
      return NextResponse.json({ error: outcome.error ?? "Deployment request not found" }, { status: 404 });
    }
    return NextResponse.json(outcome);
  }

  // Provider deployment uid — live read-only poll.
  if (!vercelConfigured()) {
    return NextResponse.json({
      ok: true, requestId: null, found: true, requestStatus: null,
      state: "unknown", providerStateRaw: null, terminal: false, health: null,
      error: "vercel provider not configured",
    });
  }
  const dep = await getVercelDeployment(id);
  if (!dep.configured || !dep.ok) {
    return NextResponse.json({
      ok: true, requestId: null, found: true, requestStatus: null,
      state: "unknown", providerStateRaw: null, terminal: false, health: null,
      error: dep.configured ? dep.error : "vercel provider not configured",
    });
  }
  const state = vercelState(dep.data.readyState, dep.data.target);
  return NextResponse.json({
    ok: true,
    requestId: null,
    found: true,
    requestStatus: null,
    state,
    providerStateRaw: dep.data.readyState,
    terminal: ["ready", "error", "canceled"].includes(state),
    health: null,
    url: dep.data.url ? `https://${dep.data.url}` : null,
    error: null,
  });
}
