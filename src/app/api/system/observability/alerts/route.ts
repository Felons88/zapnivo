import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getAlertsOverview } from "@/lib/system/obs-extra";

/** GET /api/system/observability/alerts — incidents + uptime + cron failures (system.security.audit.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const overview = await getAlertsOverview(g.db);
  return NextResponse.json(overview);
}
