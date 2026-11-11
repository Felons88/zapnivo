import { NextResponse } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agents/registry";
import { recordLog } from "@/lib/observability";
import { AGENT_ID, aiGuard, readJson } from "../../../_shared";

const schema = z.object({ task: z.string().trim().min(1).max(200) });

/**
 * Manual test invocation. The execute stub does NOT call any LLM or tool — it
 * proves the kill switch + budget/hourly gating end-to-end and writes a real
 * ai_agent_runs row.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!AGENT_ID.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "task required (1-200 chars)" }, { status: 422 });

  const outcome = await runAgent(g.db, id, {
    task: `manual:${parsed.data.task}`,
    actor: g.user.id,
    execute: async () => ({ note: "manual ping — no tools executed", agent: id, task: parsed.data.task }),
  });
  recordLog(outcome.ok ? "info" : "warning", `AI agent ${id} manual run ${outcome.status}`, {
    service: "ai-ops", route: "/api/admin/ai/agents/run",
    attrs: { agent: id, status: outcome.status, runId: outcome.runId, actor: g.user.id },
  });
  return NextResponse.json({ outcome }, { status: outcome.ok ? 200 : outcome.status === "denied" ? 409 : 500 });
}
