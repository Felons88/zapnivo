import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getEvalLab } from "@/lib/system/ai-extra";

/** GET /api/system/ai/evals — eval lab status (system.ai.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.ai.view", { limit: 120 });
  if (!g.ok) return g.res;
  const lab = await getEvalLab(g.db);
  return NextResponse.json(lab);
}
