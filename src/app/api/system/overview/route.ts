import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getSystemOverview } from "@/lib/system/overview";

/** GET /api/system/overview — Command Center aggregates (system.dashboard.view). */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const overview = await getSystemOverview(g.db);
  return NextResponse.json({ overview });
}
