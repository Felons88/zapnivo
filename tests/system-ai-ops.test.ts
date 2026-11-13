import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BULK_DISABLE_MAX,
  ESSENTIAL_AGENT_IDS,
  bulkDisableAgents,
  getAgentOpsDetail,
  getKnowledgeCounts,
  getTodayUsage,
  isEssentialAgent,
} from "@/lib/system/ai-ops";
import { listSystemUsers } from "@/lib/system/security";
import type { SystemActor } from "@/lib/system/audit";

/* ── Minimal Supabase stub (same pattern as tests/system-emergency.test.ts) ── */
type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown } = {};
  const next = (): Result => (singles.length ? singles.shift()! : { data: null, error: null });
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter", "like", "gte", "lt"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
      return b;
    };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}

const actor: SystemActor = { id: "op-1", role: "sysadmin" };

const agentRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Agent ${id}`, description: null, department: "support",
  model: "openai/gpt-4o-mini", temperature: 0.2, max_tokens: 1024, timeout_ms: 30000,
  permissions: [], tools: [], enabled: true,
  daily_budget_cents: 100, monthly_budget_cents: 1000, max_calls_per_hour: 60,
  escalation_policy: null, config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("getTodayUsage / getKnowledgeCounts", () => {
  it("groups today's runs per agent with cost + denied counts", async () => {
    const today = new Date().toISOString();
    const runs = fakeTable({
      list: {
        data: [
          { agent_id: "a.one", status: "ok", cost_cents: 1.5, created_at: today },
          { agent_id: "a.one", status: "denied", cost_cents: 0, created_at: today },
          { agent_id: "a.two", status: "error", cost_cents: 2, created_at: today },
          { agent_id: "", status: "ok", cost_cents: 9, created_at: today }, // dropped
        ],
      },
    });
    const usage = await getTodayUsage(fakeDb({ ai_agent_runs: runs }));
    expect(usage["a.one"]).toMatchObject({ calls: 2, denied: 1, costCents: 1.5 });
    expect(usage["a.two"]).toMatchObject({ calls: 1, costCents: 2 });
    expect(await getTodayUsage(null)).toEqual({});
  });

  it("counts knowledge articles by status", async () => {
    const kb = fakeTable({ list: { data: [{ status: "published" }, { status: "published" }, { status: "draft" }] } });
    const counts = await getKnowledgeCounts(fakeDb({ knowledge_articles: kb }));
    expect(counts).toMatchObject({ configured: true, total: 3 });
    expect(counts.byStatus).toEqual({ published: 2, draft: 1 });
    expect((await getKnowledgeCounts(null)).configured).toBe(false);
  });
});

describe("getAgentOpsDetail", () => {
  it("returns null for unknown agents and assembles detail for known ones", async () => {
    const missing = fakeDb({ ai_agents: fakeTable({ singles: [{ data: null, error: null }] }) });
    expect(await getAgentOpsDetail(missing, "nope")).toBeNull();
    expect(await getAgentOpsDetail(null, "x")).toBeNull();

    // Known agent: getAgent maybeSingle, then agentStats/runs/approvals lists.
    const db = fakeDb({
      ai_agents: fakeTable({ singles: [{ data: agentRow("support.qa"), error: null }] }),
      ai_agent_runs: fakeTable({
        list: { data: [{ agent_id: "support.qa", status: "ok", duration_ms: 10, cost_cents: 1, prompt_tokens: 5, completion_tokens: 7, created_at: new Date().toISOString() }] },
      }),
      ai_approvals: fakeTable({ list: { data: [], error: null, count: 2 } }),
    });
    const detail = await getAgentOpsDetail(db, "support.qa");
    expect(detail?.agent.id).toBe("support.qa");
    expect(detail?.pendingApprovals).toBe(2);
    expect(detail?.stats30d?.runs).toBe(1);
    expect(detail?.recentRuns).toHaveLength(1);
  });
});

describe("bulkDisableAgents — scoped bulk, never 'all'", () => {
  it("rejects empty and oversized id lists", async () => {
    const db = fakeDb({});
    expect(await bulkDisableAgents(db, actor, [], "reason long enough")).toMatchObject({ ok: false, status: 400 });
    const tooMany = Array.from({ length: BULK_DISABLE_MAX + 1 }, (_, i) => `agent.${i}`);
    expect(await bulkDisableAgents(db, actor, tooMany, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await bulkDisableAgents(db, actor, ["bad id!"], "reason long enough")).toMatchObject({ ok: false, status: 400 });
  });

  it("disables only the explicit ids and audits a summary", async () => {
    // Two agents: one enabled (gets killed), one already disabled, one missing.
    // maybeSingle sequence per getAgent/setAgentKillState/getAgent/updateAgent:
    //  a.one: getAgent(enabled) → setAgentKillState getAgent(enabled) → updateAgent(updated disabled)
    //  a.two: getAgent(disabled) → alreadyDisabled, no further calls
    //  ghost: getAgent(null) → skipped
    const singles = [
      { data: agentRow("a.one"), error: null },
      { data: agentRow("a.one"), error: null },
      { data: agentRow("a.one", { enabled: false, config: { kill_reason: "bulk" } }), error: null },
      { data: agentRow("a.two", { enabled: false }), error: null },
      { data: null, error: null },
    ];
    const aiAgents = fakeTable({ singles });
    const audits = fakeTable();
    const db = fakeDb({ ai_agents: aiAgents, system_audit_events: audits });

    const res = await bulkDisableAgents(db, actor, ["a.one", "a.two", "ghost"], "INC-1 bulk disable");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.disabled).toEqual(["a.one"]);
      expect(res.alreadyDisabled).toEqual(["a.two"]);
      expect(res.skipped).toEqual([{ id: "ghost", reason: "not_found" }]);
    }
    // updateAgent wrote enabled=false + kill_reason into config.
    const upd = aiAgents._update as Record<string, unknown>;
    expect(upd.enabled).toBe(false);
    expect((upd.config as Record<string, unknown>).kill_reason).toBeTruthy();
  });

  it("essential agent ids are a documented allowlist, not a bypass", () => {
    expect(ESSENTIAL_AGENT_IDS).toContain("support.public");
    expect(isEssentialAgent("support.public")).toBe(true);
    expect(isEssentialAgent("finance.review")).toBe(false);
  });
});

describe("listSystemUsers data shape (users page)", () => {
  it("maps system_role validation, suspension, and mfa flag", async () => {
    const profiles = fakeTable({
      list: {
        data: [
          { id: "u1", email: "a@x.com", full_name: "A", role: "admin", system_role: "sysadmin", mfa_required: true, system_suspended: false, created_at: "2026-01-01T00:00:00Z" },
          { id: "u2", email: "b@x.com", full_name: null, role: "staff", system_role: "bogus-role", mfa_required: false, system_suspended: true, created_at: "2026-01-02T00:00:00Z" },
          { id: "u3", email: "c@x.com", full_name: "C", role: "customer", system_role: null, mfa_required: false, system_suspended: null, created_at: "2026-01-03T00:00:00Z" },
        ],
      },
    });
    const users = await listSystemUsers(fakeDb({ profiles }));
    expect(users).toHaveLength(3);
    expect(users[0]).toMatchObject({ system_role: "sysadmin", mfa_required: true, suspended: false, business_role: "admin" });
    expect(users[1]).toMatchObject({ system_role: null, suspended: true }); // invalid role → null, suspended → true
    expect(users[2]).toMatchObject({ system_role: null, suspended: false });
  });
});
