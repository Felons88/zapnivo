import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getGuardrailsView } from "@/lib/system/ai-extra";

/** GET /api/system/ai/guardrails — agent tool permissions + AI flags (system.ai.view). Read-only. */
export async function GET() {
  const g = await systemApiGuard("system.ai.view", { limit: 120 });
  if (!g.ok) return g.res;
  const view = await getGuardrailsView(g.db);
  return NextResponse.json(view);
}
