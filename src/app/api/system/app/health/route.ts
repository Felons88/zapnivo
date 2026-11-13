import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getAppHealthSummary } from "@/lib/system/app-health";

/**
 * GET /api/system/app/health — unified per-app health summary for all 7
 * production hosts (www, customer, partners, support, internal, api, system).
 * Perm: system.deployments.view.
 *
 * Read-only aggregation of RECORDED evidence only (health-profile audit
 * events + uptime_checks). No live probes are made; apps with no evidence
 * report state 'unverified' — never fabricated as healthy.
 */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  const summary = await getAppHealthSummary(g.db);
  return NextResponse.json(summary);
}
