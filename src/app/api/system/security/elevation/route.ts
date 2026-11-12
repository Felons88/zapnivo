import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { activeElevation, ELEVATION_DEFAULT_MAX_AGE_MINUTES } from "@/lib/system/elevation";

/**
 * GET /api/system/security/elevation — current step-up elevation status for
 * the caller. Drives the "elevated for N min" banner. Elevation never extends
 * the session; it only authorizes the action window.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const elev = await activeElevation(g.db, g.user.id, ELEVATION_DEFAULT_MAX_AGE_MINUTES);
  return NextResponse.json({
    elevated: elev !== null,
    method: elev?.method ?? null,
    expiresAt: elev?.expires_at ?? null,
    maxAgeMinutes: ELEVATION_DEFAULT_MAX_AGE_MINUTES,
  });
}
