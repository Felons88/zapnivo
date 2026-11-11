import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent, updateAgent, type AgentPatch } from "@/lib/agents/registry";
import { recordLog } from "@/lib/observability";
import { AGENT_ID, aiGuard, readJson } from "../../_shared";

const slugList = z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,80}$/i)).max(50);
const patchSchema = z.object({
  model: z.string().trim().min(1).max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32000).optional(),
  timeout_ms: z.number().int().min(500).max(300000).optional(),
  permissions: slugList.optional(),
  tools: slugList.optional(),
  enabled: z.boolean().optional(),
  daily_budget_cents: z.number().int().min(0).max(100_000_000).optional(),
  monthly_budget_cents: z.number().int().min(0).max(100_000_000).optional(),
  max_calls_per_hour: z.number().int().min(1).max(10000).optional(),
  escalation_policy: z.string().trim().max(80).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Whitelisted agent config update. id/department/name are immutable. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!AGENT_ID.test(id)) return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid patch", issues: parsed.error.issues.slice(0, 5) }, { status: 422 });

  const agent = await getAgent(g.db, id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const out = await updateAgent(g.db, id, parsed.data as AgentPatch);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  recordLog("info", `AI agent ${id} updated`, {
    service: "ai-ops", route: "/api/admin/ai/agents",
    attrs: { agent: id, fields: Object.keys(parsed.data).join(","), actor: g.user.id },
  });
  return NextResponse.json({ agent: out.agent });
}
