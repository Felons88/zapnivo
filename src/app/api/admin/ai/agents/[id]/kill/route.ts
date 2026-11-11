import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent, updateAgent } from "@/lib/agents/registry";
import { recordLog } from "@/lib/observability";
import { AGENT_ID, aiGuard, readJson } from "../../../_shared";

const bodySchema = z.object({ reason: z.string().trim().max(300).optional() }).optional();

/** Kill switch: disables the agent and stamps config.kill_reason. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!AGENT_ID.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  const body = (await readJson(req)) ?? {};
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 422 });

  const agent = await getAgent(g.db, id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const config = { ...agent.config, kill_reason: parsed.data?.reason ?? `Killed by ${g.user.email} at ${new Date().toISOString()}` };
  const out = await updateAgent(g.db, id, { enabled: false, config });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  recordLog("warning", `AI agent ${id} killed`, { service: "ai-ops", route: "/api/admin/ai/agents/kill", attrs: { agent: id, actor: g.user.id, reason: parsed.data?.reason ?? null } });
  return NextResponse.json({ agent: out.agent });
}
