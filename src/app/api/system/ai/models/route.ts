import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getModelRegistry } from "@/lib/system/ai-extra";

/** GET /api/system/ai/models — model/provider registry + 30d usage (system.ai.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.ai.view", { limit: 120 });
  if (!g.ok) return g.res;
  const registry = await getModelRegistry(g.db);
  return NextResponse.json(registry);
}
