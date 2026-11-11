import { NextResponse } from "next/server";
import { getAgent, updateAgent } from "@/lib/agents/registry";
import { recordLog } from "@/lib/observability";
import { AGENT_ID, aiGuard } from "../../../_shared";

/** Re-enables a killed/disabled agent and clears config.kill_reason. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!AGENT_ID.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });

  const agent = await getAgent(g.db, id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const config = { ...agent.config };
  delete config.kill_reason;
  const out = await updateAgent(g.db, id, { enabled: true, config });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  recordLog("info", `AI agent ${id} enabled`, { service: "ai-ops", route: "/api/admin/ai/agents/enable", attrs: { agent: id, actor: g.user.id } });
  return NextResponse.json({ agent: out.agent });
}
