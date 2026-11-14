import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getSystemHealth } from "@/lib/system/health-dashboard";

/**
 * GET /api/system/health — unified technical health dashboard.
 *
 * Perm: system.dashboard.view (read-only; every system role). Aggregates
 * RECORDED evidence only — no live provider probes. Sections degrade
 * independently; 'unverified'/'awaiting_hardware' are honest states, never
 * fabricated health. No audit row: same read-only convention as
 * /api/system/app/health and /api/system/status.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const health = await getSystemHealth(g.db);
  return NextResponse.json(health);
}
