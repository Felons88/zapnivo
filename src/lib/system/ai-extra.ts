import type { SupabaseClient } from "@supabase/supabase-js";
import { providerStatus, type ProviderStatus } from "./ai";
import { getProvider, listIntegrations } from "./integrations";
import { listAgents, DENIED_ACTIONS } from "@/lib/agents/registry";
import { listFeatureFlags, type FeatureFlag } from "./flags";

/**
 * Extended AI read models for system.zapnivo.com sub-pages
 * (/system/ai/models, /system/ai/evals, /system/ai/guardrails).
 *
 * All read-only. Models are reported as "referenced in code / configured in
 * the registry" — we never claim a slug is available at the provider; that
 * requires a live call which these pages deliberately do not make (the
 * integrations health endpoint owns live checks).
 */

/* ─── Model / provider registry ─────────────────────────────────────────── */

export type ModelCatalogEntry = {
  slug: string;
  /** Where this slug came from — honest provenance, never "verified". */
  source: "code_default" | "env_config" | "agent_registry";
  detail: string;
};

export type ModelUsage = {
  slug: string;
  runs: number;
  errors: number;
  denied: number;
  costCents: number;
  promptTokens: number;
  completionTokens: number;
  lastRunAt: string | null;
};

export type ModelRegistry = {
  configured: boolean;
  providers: ProviderStatus[];
  /** OpenRouter row from the integrations registry (safe fields only). */
  openrouter: { configured: boolean; mode: string; envVars: readonly string[] } | null;
  catalog: ModelCatalogEntry[];
  usage30d: ModelUsage[];
  totals30d: { runs: number; errors: number; denied: number; costCents: number; promptTokens: number; completionTokens: number };
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/**
 * Model catalog = every slug referenced by code/config we can see:
 *  - the code default in src/lib/ai/openrouter.ts (openai/gpt-4o-mini)
 *  - OPENROUTER_MODEL env value when set (a model slug, not a secret)
 *  - model column values on registered ai_agents rows
 */
export async function getModelRegistry(db: SupabaseClient | null): Promise<ModelRegistry> {
  const providers = providerStatus();
  const openrouter = getProvider("openrouter");
  const integrations = listIntegrations();
  const orRow = integrations.find((i) => i.id === "openrouter") ?? null;

  const empty: ModelRegistry = {
    configured: Boolean(db),
    providers,
    openrouter: openrouter ? { configured: orRow?.configured ?? openrouter.configured(), mode: orRow?.mode ?? openrouter.mode(), envVars: openrouter.envVars } : null,
    catalog: [],
    usage30d: [],
    totals30d: { runs: 0, errors: 0, denied: 0, costCents: 0, promptTokens: 0, completionTokens: 0 },
  };

  // Static code references (grep-verified: src/lib/ai/openrouter.ts,
  // src/lib/system/ai.ts providerStatus fallback).
  const catalog = new Map<string, ModelCatalogEntry>();
  const add = (slug: string, source: ModelCatalogEntry["source"], detail: string) => {
    const key = slug.trim();
    if (!key || catalog.has(key)) return;
    catalog.set(key, { slug: key, source, detail });
  };
  add("openai/gpt-4o-mini", "code_default", "Fallback model in src/lib/ai/openrouter.ts and providerStatus() — used when OPENROUTER_MODEL is unset.");
  if (process.env.OPENROUTER_MODEL) {
    add(process.env.OPENROUTER_MODEL, "env_config", "Value of OPENROUTER_MODEL — model slugs are config, not secrets.");
  }

  if (!db) return { ...empty, catalog: [...catalog.values()] };

  const [agents, runsRes] = await Promise.all([
    listAgents(db),
    db
      .from("ai_agent_runs")
      .select("model,status,cost_cents,prompt_tokens,completion_tokens,created_at")
      .gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
      .limit(20_000),
  ]);

  for (const a of agents) {
    if (a.model) add(a.model, "agent_registry", `Configured on agent "${a.name}" (${a.id}).`);
  }

  type RawRun = { model: string | null; status: string; cost_cents: unknown; prompt_tokens: unknown; completion_tokens: unknown; created_at: string };
  const byModel = new Map<string, ModelUsage>();
  const totals = { runs: 0, errors: 0, denied: 0, costCents: 0, promptTokens: 0, completionTokens: 0 };
  for (const raw of (runsRes.data ?? []) as unknown as RawRun[]) {
    totals.runs += 1;
    if (raw.status === "error") totals.errors += 1;
    if (raw.status === "denied") totals.denied += 1;
    totals.costCents += num(raw.cost_cents);
    totals.promptTokens += num(raw.prompt_tokens);
    totals.completionTokens += num(raw.completion_tokens);
    const slug = raw.model?.trim();
    if (!slug) continue;
    let u = byModel.get(slug);
    if (!u) {
      u = { slug, runs: 0, errors: 0, denied: 0, costCents: 0, promptTokens: 0, completionTokens: 0, lastRunAt: null };
      byModel.set(slug, u);
    }
    u.runs += 1;
    if (raw.status === "error") u.errors += 1;
    if (raw.status === "denied") u.denied += 1;
    u.costCents += num(raw.cost_cents);
    u.promptTokens += num(raw.prompt_tokens);
    u.completionTokens += num(raw.completion_tokens);
    if (raw.created_at && (!u.lastRunAt || raw.created_at > u.lastRunAt)) u.lastRunAt = raw.created_at;
    add(slug, "agent_registry", "Model recorded on ai_agent_runs rows in the last 30 days.");
  }
  totals.costCents = Math.round(totals.costCents * 100) / 100;
  const usage30d = [...byModel.values()]
    .map((u) => ({ ...u, costCents: Math.round(u.costCents * 100) / 100 }))
    .sort((a, b) => b.runs - a.runs);

  return {
    configured: true,
    providers,
    openrouter: empty.openrouter,
    catalog: [...catalog.values()],
    usage30d,
    totals30d: totals,
  };
}

/* ─── Eval laboratory ───────────────────────────────────────────────────── */

export type EvalSuiteSummary = {
  id: string;
  name: string;
  agent_id: string | null;
  active: boolean;
  version: number;
  scenarioCount: number;
  created_at: string;
};

export type EvalRunSummary = {
  id: number;
  suite_id: string;
  suite_name: string | null;
  agent_id: string;
  model: string | null;
  score: number | null;
  passed: number;
  total: number;
  latency_ms: number | null;
  cost_cents: number | null;
  created_at: string;
};

export type EvalLab = {
  configured: boolean;
  suites: EvalSuiteSummary[];
  runs: EvalRunSummary[];
  stats30d: {
    runs: number;
    passed: number;
    total: number;
    passRatePct: number | null;
    avgScore: number | null;
    lastRunAt: string | null;
  };
};

type RawSuite = { id: string; name: string; agent_id: string | null; active: boolean; version: number; scenarios: unknown; created_at: string };
type RawEvalRun = { id: number; suite_id: string; agent_id: string; model: string | null; score: unknown; passed: number; total: number; latency_ms: number | null; cost_cents: unknown; created_at: string };

/** Read-only eval status. Authoring/running lives in the business console (/admin/evals). */
export async function getEvalLab(db: SupabaseClient | null): Promise<EvalLab> {
  const empty: EvalLab = {
    configured: Boolean(db),
    suites: [],
    runs: [],
    stats30d: { runs: 0, passed: 0, total: 0, passRatePct: null, avgScore: null, lastRunAt: null },
  };
  if (!db) return empty;

  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [suitesRes, runsRes, statsRes] = await Promise.all([
    db.from("eval_suites").select("id,name,agent_id,active,version,scenarios,created_at").order("created_at", { ascending: false }).limit(200),
    db.from("eval_runs").select("id,suite_id,agent_id,model,score,passed,total,latency_ms,cost_cents,created_at").order("created_at", { ascending: false }).limit(60),
    db.from("eval_runs").select("score,passed,total,created_at").gte("created_at", since30).limit(20_000),
  ]);

  const suiteRows = (suitesRes.data ?? []) as unknown as RawSuite[];
  const suiteName = new Map(suiteRows.map((s) => [s.id, s.name]));

  const runs = ((runsRes.data ?? []) as unknown as RawEvalRun[]).map((r) => ({
    id: num(r.id),
    suite_id: r.suite_id,
    suite_name: suiteName.get(r.suite_id) ?? null,
    agent_id: r.agent_id,
    model: r.model ?? null,
    score: r.score == null ? null : num(r.score),
    passed: num(r.passed),
    total: num(r.total),
    latency_ms: r.latency_ms == null ? null : num(r.latency_ms),
    cost_cents: r.cost_cents == null ? null : num(r.cost_cents),
    created_at: r.created_at,
  }));

  const statsRows = (statsRes.data ?? []) as unknown as { score: unknown; passed: number; total: number; created_at: string }[];
  let passed = 0, total = 0, scoreSum = 0, scoreCount = 0, lastRunAt: string | null = null;
  for (const r of statsRows) {
    passed += num(r.passed);
    total += num(r.total);
    const s = num(r.score);
    if (r.score != null && Number.isFinite(s)) { scoreSum += s; scoreCount += 1; }
    if (r.created_at && (!lastRunAt || r.created_at > lastRunAt)) lastRunAt = r.created_at;
  }

  return {
    configured: true,
    suites: suiteRows.map((s) => ({
      id: s.id,
      name: s.name,
      agent_id: s.agent_id ?? null,
      active: s.active !== false,
      version: num(s.version) || 1,
      scenarioCount: Array.isArray(s.scenarios) ? s.scenarios.length : 0,
      created_at: s.created_at,
    })),
    runs,
    stats30d: {
      runs: statsRows.length,
      passed,
      total,
      passRatePct: total ? Math.round((passed / total) * 1000) / 10 : null,
      avgScore: scoreCount ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
      lastRunAt,
    },
  };
}

/* ─── Guardrails & tool permissions ─────────────────────────────────────── */

export type GuardrailAgent = {
  id: string;
  name: string;
  department: string;
  model: string;
  enabled: boolean;
  killReason: string | null;
  tools: string[];
  permissions: string[];
  budgets: { dailyCents: number; monthlyCents: number; maxCallsPerHour: number };
  escalationPolicy: string | null;
};

export type GuardrailsView = {
  configured: boolean;
  agents: GuardrailAgent[];
  /** AI-relevant control-plane flags (metadata only — env vars still govern runtime). */
  flags: FeatureFlag[];
  /** Actions that can never be auto-approved through the approvals module. */
  deniedActions: readonly string[];
  pendingApprovals: number;
};

const AI_FLAG_KEYS = new Set(["receptionist_autosend", "ai_account_tools"]);

export async function getGuardrailsView(db: SupabaseClient | null): Promise<GuardrailsView> {
  const empty: GuardrailsView = {
    configured: Boolean(db),
    agents: [],
    flags: [],
    deniedActions: DENIED_ACTIONS,
    pendingApprovals: 0,
  };
  if (!db) return empty;

  const [agents, flags, approvalsRes] = await Promise.all([
    listAgents(db),
    listFeatureFlags(db),
    db.from("ai_approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  return {
    configured: true,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      department: a.department,
      model: a.model,
      enabled: a.enabled,
      killReason: typeof a.config?.kill_reason === "string" ? a.config.kill_reason : null,
      tools: a.tools,
      permissions: a.permissions,
      budgets: { dailyCents: a.daily_budget_cents, monthlyCents: a.monthly_budget_cents, maxCallsPerHour: a.max_calls_per_hour },
      escalationPolicy: a.escalation_policy,
    })),
    flags: flags.filter((f) => AI_FLAG_KEYS.has(f.key) || f.owner === "ai"),
    deniedActions: DENIED_ACTIONS,
    pendingApprovals: approvalsRes.count ?? 0,
  };
}
