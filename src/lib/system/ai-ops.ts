import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAgent,
  listAgents,
  listRuns,
  agentStats,
  updateAgent,
  type AgentRow,
  type AgentStats,
  type RunRow,
} from "@/lib/agents/registry";
import { systemAudit, type SystemActor } from "./audit";
import { setAgentKillState } from "./ai";

/**
 * AI ops extensions for system.zapnivo.com — read models and bulk controls
 * that complement (never modify) src/lib/system/ai.ts and the agent registry.
 *
 * Everything here is honest about instrumentation:
 *  - "today" usage is computed from ai_agent_runs rows with created_at >= UTC
 *    midnight; agents that don't report cost show 0, not estimates.
 *  - Knowledge counts come from knowledge_articles.status (migration 0029).
 *  - Bulk disable is an explicit-id-list operation — there is intentionally
 *    NO "disable everything" endpoint; callers must name the agents.
 */

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/* ─── Today's usage ─────────────────────────────────────────────────────── */

export type AgentTodayUsage = {
  calls: number;
  costCents: number;
  denied: number;
  lastRunAt: string | null;
};

function utcDayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Per-agent run/cost totals for the current UTC day, from ai_agent_runs. */
export async function getTodayUsage(db: SupabaseClient | null): Promise<Record<string, AgentTodayUsage>> {
  const out: Record<string, AgentTodayUsage> = {};
  if (!db) return out;
  const { data, error } = await db
    .from("ai_agent_runs")
    .select("agent_id,status,cost_cents,created_at")
    .gte("created_at", utcDayStartIso())
    .limit(20_000);
  if (error) return out;
  for (const raw of (data ?? []) as unknown as { agent_id: string; status: string; cost_cents: unknown; created_at: string }[]) {
    const id = String(raw.agent_id ?? "");
    if (!id) continue;
    const u = (out[id] ??= { calls: 0, costCents: 0, denied: 0, lastRunAt: null });
    u.calls += 1;
    u.costCents += num(raw.cost_cents);
    if (raw.status === "denied") u.denied += 1;
    if (raw.created_at && (!u.lastRunAt || raw.created_at > u.lastRunAt)) u.lastRunAt = raw.created_at;
  }
  for (const u of Object.values(out)) u.costCents = Math.round(u.costCents * 100) / 100;
  return out;
}

/* ─── Knowledge source counts ───────────────────────────────────────────── */

export type KnowledgeCounts = {
  configured: boolean;
  total: number;
  byStatus: Record<string, number>;
};

/** Article counts grouped by lifecycle status (knowledge_articles, migration 0029). */
export async function getKnowledgeCounts(db: SupabaseClient | null): Promise<KnowledgeCounts> {
  const empty: KnowledgeCounts = { configured: Boolean(db), total: 0, byStatus: {} };
  if (!db) return empty;
  const { data, error } = await db.from("knowledge_articles").select("status").limit(5000);
  if (error) return empty;
  const byStatus: Record<string, number> = {};
  for (const row of (data ?? []) as unknown as { status: string }[]) {
    const s = String(row.status ?? "unknown");
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { configured: true, total: (data ?? []).length, byStatus };
}

/* ─── Per-agent detail ──────────────────────────────────────────────────── */

export type AgentOpsDetail = {
  agent: AgentRow;
  stats30d: AgentStats | null;
  today: AgentTodayUsage;
  recentRuns: RunRow[];
  pendingApprovals: number;
};

/** Full read-only detail for one agent: config, 30d stats, today usage, recent runs, pending approvals. */
export async function getAgentOpsDetail(db: SupabaseClient | null, agentId: string): Promise<AgentOpsDetail | null> {
  if (!db) return null;
  const agent = await getAgent(db, agentId);
  if (!agent) return null;
  const [stats, today, recentRuns, approvalsRes] = await Promise.all([
    agentStats(db, 30),
    getTodayUsage(db),
    listRuns(db, { agentId, limit: 20 }),
    db.from("ai_approvals").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("status", "pending"),
  ]);
  return {
    agent,
    stats30d: stats[agentId] ?? null,
    today: today[agentId] ?? { calls: 0, costCents: 0, denied: 0, lastRunAt: null },
    recentRuns,
    pendingApprovals: approvalsRes.count ?? 0,
  };
}

/* ─── Bulk disable (explicit id list — never "all") ─────────────────────── */

/**
 * Agents that keep minimum customer-facing coverage during a bulk-disable.
 * Everything else is "nonessential" for the console's bulk action. This is a
 * policy label only — the API still requires the caller to pass explicit ids.
 */
export const ESSENTIAL_AGENT_IDS: readonly string[] = ["support.public", "support.customer"];

export function isEssentialAgent(agentId: string): boolean {
  return ESSENTIAL_AGENT_IDS.includes(agentId);
}

export type BulkDisableResult =
  | {
      ok: true;
      disabled: string[];
      alreadyDisabled: string[];
      skipped: { id: string; reason: string }[];
      summary: string;
    }
  | { ok: false; status: number; error: string };

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
export const BULK_DISABLE_MAX = 50;

/**
 * Disables an EXPLICIT list of agents via updateAgent (enabled=false +
 * config.kill_reason), one system audit event per agent plus a summary
 * `ai.agents.bulk_disabled` event. Agents that are missing or already disabled
 * are reported, not failed — the operation is idempotent per agent.
 */
export async function bulkDisableAgents(
  db: SupabaseClient,
  actor: SystemActor,
  agentIds: string[],
  reason: string,
): Promise<BulkDisableResult> {
  const ids = [...new Set(agentIds.map((s) => String(s).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, status: 400, error: "agent_ids must be a non-empty list" };
  if (ids.length > BULK_DISABLE_MAX) return { ok: false, status: 400, error: `agent_ids exceeds ${BULK_DISABLE_MAX}` };
  for (const id of ids) {
    if (!AGENT_ID_RE.test(id)) return { ok: false, status: 400, error: `Invalid agent id: ${id}` };
  }

  const disabled: string[] = [];
  const alreadyDisabled: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of ids) {
    const agent = await getAgent(db, id);
    if (!agent) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (!agent.enabled) {
      alreadyDisabled.push(id);
      continue;
    }
    const res = await setAgentKillState(db, actor, id, false, reason || `Bulk disable via system console by ${actor.id}`);
    if (!res.ok) {
      skipped.push({ id, reason: res.error });
      continue;
    }
    disabled.push(id);
  }

  await systemAudit(db, {
    actor,
    action: "ai.agents.bulk_disabled",
    resource: "ai_agents:bulk",
    detail: {
      requested: ids.length,
      disabled: disabled.length,
      already_disabled: alreadyDisabled.length,
      skipped: skipped.length,
      agent_ids: disabled.slice(0, 50),
      reason: reason.slice(0, 300),
    },
  });

  const summary =
    disabled.length === 0
      ? `No agents disabled (${alreadyDisabled.length} already disabled, ${skipped.length} skipped).`
      : `Disabled ${disabled.length} agent(s)${alreadyDisabled.length ? `, ${alreadyDisabled.length} already disabled` : ""}${skipped.length ? `, ${skipped.length} skipped` : ""}.`;
  return { ok: true, disabled, alreadyDisabled, skipped, summary };
}
