import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { bulkDisableAgents, BULK_DISABLE_MAX } from "@/lib/system/ai-ops";
import { requireElevation } from "@/lib/system/elevation";
import { assertApprovedOrRequest } from "@/lib/system/audit";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

const bodySchema = z.object({
  /** Explicit agent ids — there is intentionally no "all agents" option. */
  agent_ids: z.array(z.string().regex(AGENT_ID_RE)).min(1).max(BULK_DISABLE_MAX),
  reason: z.string().trim().min(10).max(300).optional(),
  justification: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/system/ai/agents/bulk — disable an EXPLICIT list of agents
 * (system.ai.manage). Scoped bulk action, NOT a global kill switch:
 *  - step-up elevation required ALWAYS (403 step_up_required otherwise)
 *  - change-request gate (breakglass role / high risk → 202 pending)
 *  - per-agent updateAgent(enabled=false) + per-agent + summary audit events
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.ai.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  // Step-up elevation — bulk disable is a high-blast-radius action.
  const elev = await requireElevation(g.db, g.user);
  if (!elev.ok) {
    return NextResponse.json({ error: elev.error, code: elev.code ?? "step_up_required" }, { status: elev.status });
  }

  const actor = { id: g.user.id, role: g.role };
  const approval = await assertApprovedOrRequest(g.db, actor, {
    action: "ai.agents.bulk_disable",
    risk: "high",
    justification:
      parsed.data.justification ??
      `Bulk-disable ${parsed.data.agent_ids.length} agent(s): ${parsed.data.agent_ids.slice(0, 10).join(", ")}${parsed.data.agent_ids.length > 10 ? "…" : ""}`,
  });
  if (approval.status === "pending") {
    return NextResponse.json({ status: "pending", changeRequestId: approval.changeRequestId, message: "Approval required — change request created." }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await bulkDisableAgents(g.db, actor, parsed.data.agent_ids, parsed.data.reason ?? "");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
