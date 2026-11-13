import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listIntegrationStatus } from "@/lib/system/integrations";

/**
 * GET /api/system/integrations — provider registry with env-presence booleans,
 * coarse modes, and honest 'unknown' status (live checks are on-demand per
 * provider via /api/system/integrations/[id]/health). Never returns secrets.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 120 });
  if (!g.ok) return g.res;
  const integrations = await listIntegrationStatus(g.db);
  return NextResponse.json({ integrations, environment: process.env.VERCEL_ENV ?? "development" });
}
