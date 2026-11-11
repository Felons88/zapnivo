import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../../_shared";
import { setAgentKillState } from "@/lib/system/ai";
import { assertApprovedOrRequest } from "@/lib/system/audit";

const bodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(300).optional(),
  justification: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/system/ai/agents/[id]/kill — agent kill-switch (system.ai.manage).
 * Real write path: ai_agents.enabled + config.kill_reason, audited.
 * Breakglass callers / high-risk contexts route through the change-request gate.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.ai.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await params;
  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: `ai.agent.${parsed.data.enabled ? "enable" : "kill"}:${id}`,
    risk: "medium",
    justification: parsed.data.justification ?? `Agent ${id} ${parsed.data.enabled ? "re-enabled" : "killed"} via system console`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setAgentKillState(g.db, actor, id, parsed.data.enabled, parsed.data.reason);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ agent: result.agent });
}
