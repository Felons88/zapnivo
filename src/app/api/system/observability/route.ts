import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getObservabilityOverview } from "@/lib/system/observability";

/** GET /api/system/observability — telemetry overview (system.security.audit.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const overview = await getObservabilityOverview(g.db);
  return NextResponse.json(overview);
}
