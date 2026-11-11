import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";

/**
 * AI agent registry + control center (stage 3). Server-only: every function
 * takes the service client explicitly so routes/pages stay auditable.
 *
 * Guardrails enforced here, not in callers:
 *  - canRun(): enabled flag, hourly call cap, daily + monthly cost budgets.
 *  - runAgent(): a disabled/over-budget agent records a 'denied' run and never
 *    invokes execute(). Errors are scrubbed before they touch the DB.
 *  - Approvals: payloads are sanitized (secret-looking keys dropped, strings
 *    truncated) and DENIED_ACTIONS can never be approved through this module.
 */

export type AgentsDb = SupabaseClient;

export type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  department: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  permissions: string[];
  tools: string[];
  enabled: boolean;
  daily_budget_cents: number;
  monthly_budget_cents: number;
  max_calls_per_hour: number;
  escalation_policy: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type RunStatus = "running" | "ok" | "error" | "escalated" | "denied";

export type RunRow = {
  id: number;
  agent_id: string;
  task: string;
  status: RunStatus;
  duration_ms: number | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_cents: number | null;
  tool_calls: number;
  error: string | null;
  actor: string | null;
  created_at: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRow = {
  id: string;
  agent_id: string;
  run_id: number | null;
  action: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

/* ─── Seed agents ──────────────────────────────────────────────────────────── */

export type SeedAgent = Pick<AgentRow, "id" | "name" | "department" | "description" | "permissions" | "escalation_policy">;

export const SEED_AGENTS: SeedAgent[] = [
  { id: "support.public", name: "Public Customer Support", department: "support", description: "First-line answers for anonymous visitors: hours, coverage, how rentals work.", permissions: ["support.public.read", "support.ticket.create"], escalation_policy: "needs_human" },
  { id: "support.customer", name: "Authenticated Customer Support", department: "support", description: "Account-aware help for signed-in customers on rentals, returns and account questions.", permissions: ["support.customer.read_own", "support.ticket.create", "support.ticket.reply"], escalation_policy: "needs_human" },
  { id: "rental.troubleshooting", name: "Rental Troubleshooting", department: "operations", description: "Guided diagnostics for chargers that won't start, dock or bill correctly.", permissions: ["support.customer.read_own", "fleet.telemetry.read", "support.ticket.reply"], escalation_policy: "staff_review" },
  { id: "billing.assistance", name: "Billing Assistance", department: "finance", description: "Explains charges, holds and receipts. Never issues refunds — drafts explanations only.", permissions: ["support.customer.read_own", "support.ticket.reply"], escalation_policy: "needs_human" },
  { id: "partner.support", name: "Partner Support", department: "support", description: "Helps venue partners with kiosk setup, payouts timelines and listing questions.", permissions: ["partner.read_scoped", "support.ticket.reply"], escalation_policy: "needs_human" },
  { id: "support.escalation", name: "Human Escalation Coordinator", department: "support", description: "Classifies and routes tickets that need a human; summarizes context for staff.", permissions: ["support.ticket.create", "support.ticket.reply"], escalation_policy: "staff_review" },
  { id: "support.qa", name: "Support Quality Assurance", department: "support", description: "Reviews closed threads for tone, accuracy and policy compliance.", permissions: ["support.customer.read_own", "analytics.aggregate.read"], escalation_policy: null },
  { id: "knowledge.mgmt", name: "Knowledge Management", department: "support", description: "Drafts and updates help-center articles; drafts only, never publishes.", permissions: ["knowledge.draft.create"], escalation_policy: "staff_review" },
  { id: "growth.analytics", name: "Growth Analytics", department: "growth", description: "Summarizes aggregate funnel and campaign metrics for staff review.", permissions: ["analytics.aggregate.read"], escalation_policy: null },
  { id: "sales.qualification", name: "Sales Qualification", department: "growth", description: "Qualifies inbound venue/partner interest and drafts follow-ups.", permissions: ["analytics.aggregate.read"], escalation_policy: "staff_review" },
  { id: "fleet.ops", name: "Fleet Operations", department: "operations", description: "Reads station telemetry to spot offline/low-battery patterns and suggest checks.", permissions: ["fleet.telemetry.read"], escalation_policy: "staff_review" },
  { id: "finance.review", name: "Finance Review", department: "finance", description: "Reads finance reports to flag anomalies; never moves money.", permissions: ["finance.reports.read"], escalation_policy: "staff_review" },
  { id: "executive.reporting", name: "Executive Reporting", department: "executive", description: "Compiles weekly operating summaries from aggregate data only.", permissions: ["analytics.aggregate.read", "finance.reports.read"], escalation_policy: null },
];

/**
 * Idempotent seed — upsert-on-conflict-do-nothing so operator edits to seeded
 * rows are never overwritten. Called lazily by the admin page/API, not a migration.
 */
export async function ensureSeedAgents(db: AgentsDb): Promise<void> {
  const rows = SEED_AGENTS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    department: s.department,
    permissions: s.permissions,
    escalation_policy: s.escalation_policy,
    tools: [] as string[],
    enabled: true,
    config: {} as Record<string, unknown>,
  }));
  await db.from("ai_agents").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
}

/* ─── Row mapping ──────────────────────────────────────────────────────────── */

type RawAgent = Record<string, unknown>;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

function toAgent(r: RawAgent): AgentRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    description: (r.description as string | null) ?? null,
    department: String(r.department ?? ""),
    model: String(r.model ?? ""),
    temperature: num(r.temperature),
    max_tokens: num(r.max_tokens),
    timeout_ms: num(r.timeout_ms),
    permissions: strArr(r.permissions),
    tools: strArr(r.tools),
    enabled: r.enabled !== false,
    daily_budget_cents: num(r.daily_budget_cents),
    monthly_budget_cents: num(r.monthly_budget_cents),
    max_calls_per_hour: num(r.max_calls_per_hour),
    escalation_policy: (r.escalation_policy as string | null) ?? null,
    config: (r.config && typeof r.config === "object" && !Array.isArray(r.config) ? r.config : {}) as Record<string, unknown>,
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

function toRun(r: RawAgent): RunRow {
  return {
    id: num(r.id),
    agent_id: String(r.agent_id ?? ""),
    task: String(r.task ?? ""),
    status: (r.status as RunStatus) ?? "ok",
    duration_ms: r.duration_ms == null ? null : num(r.duration_ms),
    model: (r.model as string | null) ?? null,
    prompt_tokens: r.prompt_tokens == null ? null : num(r.prompt_tokens),
    completion_tokens: r.completion_tokens == null ? null : num(r.completion_tokens),
    cost_cents: r.cost_cents == null ? null : num(r.cost_cents),
    tool_calls: num(r.tool_calls),
    error: (r.error as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

function toApproval(r: RawAgent): ApprovalRow {
  return {
    id: String(r.id),
    agent_id: String(r.agent_id ?? ""),
    run_id: r.run_id == null ? null : num(r.run_id),
    action: String(r.action ?? ""),
    payload: (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload : {}) as Record<string, unknown>,
    status: (r.status as ApprovalStatus) ?? "pending",
    decided_by: (r.decided_by as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    decision_note: (r.decision_note as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

/* ─── Agents ───────────────────────────────────────────────────────────────── */

export async function listAgents(db: AgentsDb): Promise<AgentRow[]> {
  const { data, error } = await db.from("ai_agents").select("*").order("id");
  if (error) return [];
  return ((data ?? []) as unknown as RawAgent[]).map(toAgent);
}

export async function getAgent(db: AgentsDb, id: string): Promise<AgentRow | null> {
  const { data, error } = await db.from("ai_agents").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return toAgent(data as unknown as RawAgent);
}

const PATCHABLE = [
  "model", "temperature", "max_tokens", "timeout_ms", "permissions", "tools", "enabled",
  "daily_budget_cents", "monthly_budget_cents", "max_calls_per_hour", "escalation_policy", "config",
] as const;
export type AgentPatch = Partial<Pick<AgentRow, (typeof PATCHABLE)[number]>>;

const SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" && SLUG.test(x));
const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Whitelisted partial update. id/name/description/department are immutable here.
 * Invalid provided fields reject the whole patch (fail loud, not silent).
 */
export async function updateAgent(db: AgentsDb, id: string, patch: AgentPatch): Promise<{ ok: true; agent: AgentRow } | { ok: false; error: string }> {
  const update: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    const v = patch[key];
    if (v === undefined) continue;
    switch (key) {
      case "model":
        if (typeof v !== "string" || !v.trim() || v.trim().length > 120) return { ok: false, error: "invalid_model" };
        update.model = v.trim();
        break;
      case "temperature":
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 2) return { ok: false, error: "invalid_temperature" };
        update.temperature = v;
        break;
      case "max_tokens":
        if (!intIn(v, 1, 32000)) return { ok: false, error: "invalid_max_tokens" };
        update.max_tokens = v;
        break;
      case "timeout_ms":
        if (!intIn(v, 500, 300000)) return { ok: false, error: "invalid_timeout_ms" };
        update.timeout_ms = v;
        break;
      case "permissions":
      case "tools":
        if (!isStrArr(v)) return { ok: false, error: `invalid_${key}` };
        update[key] = v;
        break;
      case "enabled":
        if (typeof v !== "boolean") return { ok: false, error: "invalid_enabled" };
        update.enabled = v;
        break;
      case "daily_budget_cents":
      case "monthly_budget_cents":
        if (!intIn(v, 0, 100_000_000)) return { ok: false, error: `invalid_${key}` };
        update[key] = v;
        break;
      case "max_calls_per_hour":
        if (!intIn(v, 1, 10000)) return { ok: false, error: "invalid_max_calls_per_hour" };
        update.max_calls_per_hour = v;
        break;
      case "escalation_policy":
        if (v !== null && (typeof v !== "string" || v.trim().length > 80)) return { ok: false, error: "invalid_escalation_policy" };
        update.escalation_policy = typeof v === "string" ? v.trim() : null;
        break;
      case "config": {
        if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "invalid_config" };
        const clean = sanitizeApprovalPayload(v);
        if (JSON.stringify(clean).length > 8000) return { ok: false, error: "config_too_large" };
        update.config = clean;
        break;
      }
    }
  }
  if (!Object.keys(update).length) return { ok: false, error: "empty_patch" };
  update.updated_at = new Date().toISOString();
  const { data, error } = await db.from("ai_agents").update(update).eq("id", id).select("*").maybeSingle();
  if (error || !data) return { ok: false, error: "update_failed" };
  return { ok: true, agent: toAgent(data as unknown as RawAgent) };
}

/* ─── Run gating ───────────────────────────────────────────────────────────── */

export type RunGate = { ok: true } | { ok: false; reason: string };

/**
 * Enforcement point for every agent invocation. Fail-closed on telemetry errors:
 * if we can't see recent runs we can't prove budget compliance.
 */
export async function canRun(db: AgentsDb, agent: AgentRow): Promise<RunGate> {
  if (!agent.enabled) return { ok: false, reason: "agent_disabled" };
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await db
    .from("ai_agent_runs")
    .select("created_at,cost_cents")
    .eq("agent_id", agent.id)
    .gte("created_at", monthStart.toISOString());
  if (error) return { ok: false, reason: "run_stats_unavailable" };

  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  let callsThisHour = 0;
  let costToday = 0;
  let costMonth = 0;
  for (const r of (data ?? []) as unknown as { created_at: string; cost_cents: unknown }[]) {
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t)) continue;
    const cost = num(r.cost_cents);
    costMonth += cost;
    if (t >= dayStartMs) costToday += cost;
    if (t >= hourAgo) callsThisHour += 1;
  }
  if (callsThisHour >= agent.max_calls_per_hour) return { ok: false, reason: "hourly_call_cap" };
  if (agent.daily_budget_cents > 0 && costToday >= agent.daily_budget_cents) return { ok: false, reason: "daily_budget_exceeded" };
  if (agent.monthly_budget_cents > 0 && costMonth >= agent.monthly_budget_cents) return { ok: false, reason: "monthly_budget_exceeded" };
  return { ok: true };
}

/* ─── Scrubbing ────────────────────────────────────────────────────────────── */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /\b(?:sk|pk|xox[baprs]|ghp|gho|ghu|ghs|ghr|glpat|AKIA|AIza|ya29)[A-Za-z0-9_-]{6,}\b/g;
const KV_SECRET_RE = /\b(token|api[-_]?key|secret|password|passwd|otp|pan|card)\b\s*[:=]\s*\S+/gi;
const LONG_SECRET_RE = /\b[A-Za-z0-9+/=_-]{40,}\b/g;

/** First 200 chars, with emails/tokens/otp-like material redacted. Safe to store. */
export function scrubError(input: unknown): string {
  let s = input instanceof Error ? input.message : String(input ?? "");
  s = s.replace(KV_SECRET_RE, "$1=[redacted]")
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_RE, "[redacted]")
    .replace(LONG_SECRET_RE, "[redacted]");
  return s.slice(0, 200);
}

const SECRET_KEY_RE = /secret|token|key|password|otp|pan|card/i;
const MAX_STR = 500;
const MAX_DEPTH = 6;

function cleanValue(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cleanValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue; // drop secret-looking keys entirely
      out[k] = cleanValue(val, depth + 1);
    }
    return out;
  }
  return String(v).slice(0, MAX_STR);
}

/** Sanitizes an approval payload: secret-like keys dropped, strings ≤500 chars, depth/array bounded. */
export function sanitizeApprovalPayload(payload: unknown): Record<string, unknown> {
  const cleaned = cleanValue(payload ?? {}, 0);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) ? (cleaned as Record<string, unknown>) : {};
}

/* ─── Approvals ────────────────────────────────────────────────────────────── */

/** Actions that must always go through humans — never auto-approved by this module. */
export const DENIED_ACTIONS = [
  "refund.issue",
  "payout.modify",
  "payment.adjust",
  "contract.change",
  "hardware.control",
  "admin.grant",
  "account.modify",
] as const;

export async function requestApproval(
  db: AgentsDb,
  input: { agentId: string; runId?: number | null; action: string; payload: unknown },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const action = String(input.action ?? "").trim();
  if (!SLUG.test(action) || action.length > 120) return { ok: false, error: "invalid_action" };
  const { data, error } = await db.from("ai_approvals").insert({
    agent_id: input.agentId,
    run_id: input.runId ?? null,
    action,
    payload: sanitizeApprovalPayload(input.payload),
    status: "pending",
  }).select("id").single();
  if (error || !data) return { ok: false, error: "approval_failed" };
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * Staff decision on a pending approval. Denied actions can never be approved
 * here — they stay pending (or can be rejected) for a human workflow outside
 * this module. Non-uuid staff ids (dev personas) store decided_by as null.
 */
export async function decideApproval(
  db: AgentsDb,
  id: string,
  staffUserId: string,
  approve: boolean,
  note?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await db.from("ai_approvals").select("id,action,status").eq("id", id).maybeSingle();
  if (error || !data) return { ok: false, error: "not_found" };
  const row = data as unknown as { id: string; action: string; status: string };
  if (row.status !== "pending") return { ok: false, error: "already_decided" };
  if (approve && (DENIED_ACTIONS as readonly string[]).includes(row.action)) {
    recordLog("warning", `Blocked approval of denied action ${row.action}`, { service: "ai-ops", route: "/api/admin/ai/approvals", attrs: { approval: row.id, action: row.action } });
    return { ok: false, error: "action_not_approvable" };
  }
  const decidedBy = /^[0-9a-f-]{36}$/i.test(staffUserId) ? staffUserId : null;
  const { error: upErr } = await db.from("ai_approvals").update({
    status: approve ? "approved" : "rejected",
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    decision_note: note ? note.slice(0, 500) : null,
  }).eq("id", id).eq("status", "pending");
  if (upErr) return { ok: false, error: "decision_failed" };
  return { ok: true };
}

export async function listApprovals(db: AgentsDb, status: ApprovalStatus = "pending", limit = 100): Promise<ApprovalRow[]> {
  const { data, error } = await db.from("ai_approvals").select("*").eq("status", status).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return ((data ?? []) as unknown as RawAgent[]).map(toApproval);
}

/* ─── Runs ─────────────────────────────────────────────────────────────────── */

export async function recordRun(
  db: AgentsDb,
  run: {
    agentId: string;
    task: string;
    status: RunStatus;
    durationMs?: number | null;
    model?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    costCents?: number | null;
    toolCalls?: number;
    error?: string | null;
    actor?: string | null;
  },
): Promise<number | null> {
  const { data, error } = await db.from("ai_agent_runs").insert({
    agent_id: run.agentId,
    task: String(run.task ?? "").slice(0, 200),
    status: run.status,
    duration_ms: run.durationMs ?? null,
    model: run.model ?? null,
    prompt_tokens: run.promptTokens ?? null,
    completion_tokens: run.completionTokens ?? null,
    cost_cents: run.costCents ?? null,
    tool_calls: run.toolCalls ?? 0,
    error: run.error ? scrubError(run.error) : null,
    actor: run.actor ?? "system",
  }).select("id").single();
  if (error || !data) return null;
  return num((data as { id: unknown }).id) || null;
}

export type RunOutcome<T> =
  | { ok: true; status: "ok" | "escalated"; result: T; runId: number | null }
  | { ok: false; status: "denied" | "error"; reason?: string; error?: string; runId: number | null };

/**
 * Runs an agent behind the control-center gates. `execute` is the caller's
 * real work (LLM call, tool loop, …). Returning `{ escalated: true }` records
 * an 'escalated' run; throwing records a scrubbed 'error'. A denied gate
 * records 'denied' and never calls execute.
 */
export async function runAgent<T>(
  db: AgentsDb,
  agentId: string,
  opts: { task: string; actor?: string; execute: () => Promise<T> },
): Promise<RunOutcome<T>> {
  const agent = await getAgent(db, agentId);
  if (!agent) return { ok: false, status: "error", error: "unknown_agent", runId: null };

  const gate = await canRun(db, agent);
  if (!gate.ok) {
    const runId = await recordRun(db, { agentId: agent.id, task: opts.task, status: "denied", error: gate.reason, actor: opts.actor });
    return { ok: false, status: "denied", reason: gate.reason, runId };
  }

  // Insert a 'running' row first so approvals/tool calls can reference runId mid-flight.
  const start = Date.now();
  const runId = await recordRun(db, { agentId: agent.id, task: opts.task, status: "running", model: agent.model, actor: opts.actor });

  const finish = async (status: Exclude<RunStatus, "running" | "denied">, extra: { error?: string } = {}) => {
    const duration = Date.now() - start;
    if (runId != null) {
      await db.from("ai_agent_runs").update({
        status, duration_ms: duration, error: extra.error ? scrubError(extra.error) : null,
      }).eq("id", runId);
    } else {
      await recordRun(db, { agentId: agent.id, task: opts.task, status, durationMs: duration, model: agent.model, error: extra.error, actor: opts.actor });
    }
  };

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`agent_timeout_${agent.timeout_ms}ms`)), agent.timeout_ms);
    });
    const result = await Promise.race([opts.execute(), timeout]).finally(() => clearTimeout(timer));
    const escalated = typeof result === "object" && result !== null && (result as { escalated?: unknown }).escalated === true;
    await finish(escalated ? "escalated" : "ok");
    return { ok: true, status: escalated ? "escalated" : "ok", result, runId };
  } catch (e) {
    const msg = scrubError(e);
    await finish("error", { error: msg });
    return { ok: false, status: "error", error: msg, runId };
  }
}

/* ─── Stats ────────────────────────────────────────────────────────────────── */

export type AgentStats = {
  runs: number;
  ok: number;
  errors: number;
  denied: number;
  escalated: number;
  errorRate: number;
  avgDurationMs: number | null;
  costCents: number;
  promptTokens: number;
  completionTokens: number;
  lastRunAt: string | null;
};

/** Per-agent aggregates over the trailing `days` window, grouped in JS (fine at this scale). */
export async function agentStats(db: AgentsDb, days = 30): Promise<Record<string, AgentStats>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await db
    .from("ai_agent_runs")
    .select("agent_id,status,duration_ms,cost_cents,prompt_tokens,completion_tokens,created_at")
    .gte("created_at", since)
    .limit(20_000);
  if (error) return {};
  const out: Record<string, AgentStats> = {};
  for (const raw of (data ?? []) as unknown as RawAgent[]) {
    const id = String(raw.agent_id ?? "");
    if (!id) continue;
    const s = (out[id] ??= { runs: 0, ok: 0, errors: 0, denied: 0, escalated: 0, errorRate: 0, avgDurationMs: null, costCents: 0, promptTokens: 0, completionTokens: 0, lastRunAt: null });
    s.runs += 1;
    const status = String(raw.status ?? "");
    if (status === "ok") s.ok += 1;
    else if (status === "error") s.errors += 1;
    else if (status === "denied") s.denied += 1;
    else if (status === "escalated") s.escalated += 1;
    s.costCents += num(raw.cost_cents);
    s.promptTokens += num(raw.prompt_tokens);
    s.completionTokens += num(raw.completion_tokens);
    const created = String(raw.created_at ?? "");
    if (created && (!s.lastRunAt || created > s.lastRunAt)) s.lastRunAt = created;
    const dur = raw.duration_ms == null ? null : num(raw.duration_ms);
    if (dur != null) {
      s.avgDurationMs = s.avgDurationMs == null ? dur : (s.avgDurationMs * (s.runs - 1) + dur) / s.runs;
    }
  }
  for (const s of Object.values(out)) {
    s.errorRate = s.runs ? Math.round((s.errors / s.runs) * 1000) / 10 : 0;
    s.avgDurationMs = s.avgDurationMs == null ? null : Math.round(s.avgDurationMs);
    s.costCents = Math.round(s.costCents * 100) / 100;
  }
  return out;
}

export async function listRuns(
  db: AgentsDb,
  opts: { agentId?: string; limit?: number } = {},
): Promise<RunRow[]> {
  let q = db.from("ai_agent_runs").select("*").order("created_at", { ascending: false }).limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  if (opts.agentId) q = q.eq("agent_id", opts.agentId);
  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as unknown as RawAgent[]).map(toRun);
}
