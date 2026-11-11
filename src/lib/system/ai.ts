import type { SupabaseClient } from "@supabase/supabase-js";
import { agentStats, getAgent, listAgents, updateAgent, type AgentRow, type AgentStats } from "@/lib/agents/registry";
import { systemAudit, type SystemActor } from "./audit";

/**
 * AI infrastructure read model + control helpers for system.zapnivo.com.
 *
 * Read side is honest about instrumentation: provider config reports only
 * presence booleans and env var NAMES (never values); token/cost usage comes
 * from ai_agent_runs (the real usage table) — if it has no rows the UI says so.
 *
 * Mutations: kill-switch maps to ai_agents.enabled + config.kill_reason (the
 * same convention as /api/admin/ai/agents/[id]/kill). Tool edits map to the
 * `tools` allowlist column via updateAgent's whitelist validation. Both are
 * real write paths — no 'requires_implementation' placeholders needed here.
 */

export type ProviderStatus = {
  name: string;
  /** Env var NAME that must be set — never the value. */
  keyEnv: string;
  configured: boolean;
  modelEnv?: string;
  /** Model env var NAME + its configured value is a model slug, not a secret — safe to show. */
  model?: string | null;
};

export function providerStatus(): ProviderStatus[] {
  return [
    {
      name: "OpenRouter (LLM gateway)",
      keyEnv: "OPENROUTER_API_KEY",
      configured: Boolean(process.env.OPENROUTER_API_KEY),
      modelEnv: "OPENROUTER_MODEL",
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini (default)",
    },
    {
      name: "Receptionist autonomy",
      keyEnv: "RECEPTIONIST_AUTONOMY",
      configured: Boolean(process.env.RECEPTIONIST_AUTONOMY),
    },
  ];
}

export type EvalRunSummary = {
  suite_id: string;
  agent_id: string;
  model: string | null;
  score: number | null;
  passed: number;
  total: number;
  latency_ms: number | null;
  created_at: string;
};

export type AiOverview = {
  configured: boolean;
  providers: ProviderStatus[];
  agents: { agent: AgentRow; stats: AgentStats | null }[];
  totals: {
    agents: number;
    enabled: number;
    disabled: number;
    runs30d: number;
    costCents30d: number;
    promptTokens30d: number;
    completionTokens30d: number;
    denied30d: number;
    errorRate30d: number | null;
  };
  evals: {
    suites: number;
    activeSuites: number;
    latestRuns: EvalRunSummary[];
  };
  approvals: { pending: number };
};

export async function getAiOverview(db: SupabaseClient | null): Promise<AiOverview> {
  const providers = providerStatus();
  const empty: AiOverview = {
    configured: Boolean(db),
    providers,
    agents: [],
    totals: { agents: 0, enabled: 0, disabled: 0, runs30d: 0, costCents30d: 0, promptTokens30d: 0, completionTokens30d: 0, denied30d: 0, errorRate30d: null },
    evals: { suites: 0, activeSuites: 0, latestRuns: [] },
    approvals: { pending: 0 },
  };
  if (!db) return empty;

  const [agents, stats, suitesRes, runsRes, approvalsRes] = await Promise.all([
    listAgents(db),
    agentStats(db, 30),
    db.from("eval_suites").select("id,name,agent_id,active").order("created_at", { ascending: false }).limit(100),
    db.from("eval_runs").select("suite_id,agent_id,model,score,passed,total,latency_ms,created_at").order("created_at", { ascending: false }).limit(60),
    db.from("ai_approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const suiteRows = (suitesRes.data ?? []) as { id: string; active: boolean }[];
  const runRows = (runsRes.data ?? []) as EvalRunSummary[];
  // Latest run per suite.
  const latestBySuite = new Map<string, EvalRunSummary>();
  for (const r of runRows) if (!latestBySuite.has(r.suite_id)) latestBySuite.set(r.suite_id, r);

  const totals = {
    agents: agents.length,
    enabled: agents.filter((a) => a.enabled).length,
    disabled: agents.filter((a) => !a.enabled).length,
    runs30d: 0,
    costCents30d: 0,
    promptTokens30d: 0,
    completionTokens30d: 0,
    denied30d: 0,
    errorRate30d: null as number | null,
  };
  for (const s of Object.values(stats)) {
    totals.runs30d += s.runs;
    totals.costCents30d += s.costCents;
    totals.promptTokens30d += s.promptTokens;
    totals.completionTokens30d += s.completionTokens;
    totals.denied30d += s.denied;
  }
  totals.costCents30d = Math.round(totals.costCents30d * 100) / 100;
  totals.errorRate30d = totals.runs30d ? Math.round(((Object.values(stats).reduce((a, s) => a + s.errors, 0)) / totals.runs30d) * 1000) / 10 : null;

  return {
    configured: true,
    providers,
    agents: agents.map((a) => ({ agent: a, stats: stats[a.id] ?? null })),
    totals,
    evals: {
      suites: suiteRows.length,
      activeSuites: suiteRows.filter((s) => s.active).length,
      latestRuns: [...latestBySuite.values()].slice(0, 20),
    },
    approvals: { pending: approvalsRes.count ?? 0 },
  };
}

export type AgentControlResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; status: number; error: string };

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

/** Kill-switch / re-enable. Mirrors the admin kill convention: enabled flag + config.kill_reason. */
export async function setAgentKillState(
  db: SupabaseClient,
  actor: SystemActor,
  agentId: string,
  enabled: boolean,
  reason?: string,
): Promise<AgentControlResult> {
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, status: 400, error: "Invalid agent id" };
  const agent = await getAgent(db, agentId);
  if (!agent) return { ok: false, status: 404, error: "Agent not found" };
  const config = { ...agent.config };
  if (enabled) delete config.kill_reason;
  else config.kill_reason = reason ?? `Killed via system console by ${actor.id} at ${new Date().toISOString()}`;
  const out = await updateAgent(db, agentId, { enabled, config });
  if (!out.ok) return { ok: false, status: 422, error: out.error };
  await systemAudit(db, {
    actor,
    action: enabled ? "ai.agent.enabled" : "ai.agent.killed",
    resource: `ai_agent:${agentId}`,
    detail: { agent: agentId, name: agent.name, reason: enabled ? null : (reason ?? "console kill switch") },
  });
  return { ok: true, agent: out.agent };
}

/** Tool allowlist edit — validated by updateAgent's whitelist (slug array, ≤50). */
export async function setAgentTools(
  db: SupabaseClient,
  actor: SystemActor,
  agentId: string,
  tools: string[],
): Promise<AgentControlResult> {
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, status: 400, error: "Invalid agent id" };
  const agent = await getAgent(db, agentId);
  if (!agent) return { ok: false, status: 404, error: "Agent not found" };
  const out = await updateAgent(db, agentId, { tools });
  if (!out.ok) return { ok: false, status: 422, error: out.error };
  await systemAudit(db, {
    actor,
    action: "ai.agent.tools_updated",
    resource: `ai_agent:${agentId}`,
    detail: { agent: agentId, before: agent.tools, after: tools },
  });
  return { ok: true, agent: out.agent };
}
