import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../../_shared";
import { setAgentTools } from "@/lib/system/ai";
import { assertApprovedOrRequest } from "@/lib/system/audit";

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const bodySchema = z.object({
  tools: z.array(z.string().regex(SLUG)).max(50),
  justification: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/system/ai/agents/[id]/tools — replace an agent's tool allowlist
 * (system.ai.manage). Validated by updateAgent's whitelist; audited.
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
    action: `ai.agent.tools:${id}`,
    risk: "medium",
    justification: parsed.data.justification ?? `Update tool allowlist for agent ${id} (${parsed.data.tools.length} tools)`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setAgentTools(g.db, actor, id, parsed.data.tools);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ agent: result.agent });
}
