import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getAiOverview } from "@/lib/system/ai";

/** GET /api/system/ai — AI infrastructure overview (system.ai.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.ai.view", { limit: 120 });
  if (!g.ok) return g.res;
  const overview = await getAiOverview(g.db);
  return NextResponse.json(overview);
}
