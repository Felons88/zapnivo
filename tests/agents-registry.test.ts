import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/observability", () => ({ recordLog: vi.fn(), recordSpan: vi.fn(), reportError: vi.fn() }));

import {
  canRun, decideApproval, getAgent, requestApproval, runAgent,
  sanitizeApprovalPayload, scrubError, updateAgent, DENIED_ACTIONS,
  type AgentRow,
} from "@/lib/agents/registry";

type Row = Record<string, unknown>;

/** Tiny in-memory Supabase fake: supports the exact query shapes registry.ts uses. */
function makeDb(seed: { agents?: Row[]; runs?: Row[]; approvals?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    ai_agents: [...(seed.agents ?? [])],
    ai_agent_runs: [...(seed.runs ?? [])],
    ai_approvals: [...(seed.approvals ?? [])],
  };
  let runSeq = 100;
  let apprSeq = 1;

  class Q {
    private filters: ((r: Row) => boolean)[] = [];
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row | Row[] | null = null;
    private ignoreDup = false;
    private ord: string | null = null;
    private ordAsc = true;
    private lim: number | null = null;
    private mode: "single" | "maybe" | null = null;

    constructor(private table: string) {}
    select() { return this; }
    insert(row: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(row) ? row : [row]; return this; }
    upsert(rows: Row[], opts?: { ignoreDuplicates?: boolean }) { this.op = "upsert"; this.payload = rows; this.ignoreDup = !!opts?.ignoreDuplicates; return this; }
    update(obj: Row) { this.op = "update"; this.payload = obj; return this; }
    eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
    gte(col: string, val: unknown) { this.filters.push((r) => typeof r[col] === "string" && String(r[col]) >= String(val)); return this; }
    order(col: string, opts?: { ascending?: boolean }) { this.ord = col; this.ordAsc = opts?.ascending !== false; return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }

    private finish(rows: Row[]) {
      const data = this.mode ? rows[0] ?? null : rows;
      const error = this.mode === "single" && !rows.length ? { message: "no rows" } : null;
      return { data, error };
    }

    private exec() {
      const t = tables[this.table];
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const rows = (this.payload as Row[]).map((r) => {
          const row = { ...r };
          if (this.table === "ai_agent_runs" && row.id == null) row.id = runSeq++;
          if (this.table === "ai_approvals" && row.id == null) row.id = `appr-${String(apprSeq++).padStart(4, "0")}`;
          t.push(row);
          return row;
        });
        return this.finish(rows);
      }
      if (this.op === "upsert") {
        for (const r of this.payload as Row[]) {
          const ex = t.find((x) => x.id === r.id);
          if (ex) { if (!this.ignoreDup) Object.assign(ex, r); }
          else t.push({ ...r });
        }
        return this.finish(t.filter(match));
      }
      if (this.op === "update") {
        const affected = t.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return this.finish(affected);
      }
      let out = t.filter(match);
      if (this.ord) {
        out = [...out].sort((a, b) => {
          const av = a[this.ord!]; const bv = b[this.ord!];
          const c = av === bv ? 0 : av! > bv! ? 1 : -1;
          return this.ordAsc ? c : -c;
        });
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return this.finish(out);
    }

    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onF?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onR?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) { return Promise.resolve(this.exec()).then(onF, onR); }
  }

  return { db: { from: (t: string) => new Q(t) } as unknown as SupabaseClient, tables };
}

const AGENT: AgentRow = {
  id: "support.public", name: "Public", description: null, department: "support",
  model: "openai/gpt-4o-mini", temperature: 0.2, max_tokens: 700, timeout_ms: 25000,
  permissions: ["support.public.read"], tools: [], enabled: true,
  daily_budget_cents: 0, monthly_budget_cents: 0, max_calls_per_hour: 60,
  escalation_policy: null, config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

const agentRow = (over: Partial<Row> = {}): Row => ({ ...AGENT, ...over });

describe("runAgent gating", () => {
  it("disabled agent records 'denied' and never calls execute", async () => {
    const { db, tables } = makeDb({ agents: [agentRow({ enabled: false })] });
    const execute = vi.fn(async () => ({ ok: 1 }));
    const out = await runAgent(db, "support.public", { task: "ping", execute });
    expect(out).toMatchObject({ ok: false, status: "denied", reason: "agent_disabled" });
    expect(execute).not.toHaveBeenCalled();
    const runs = tables.ai_agent_runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent_id: "support.public", status: "denied", error: "agent_disabled" });
  });

  it("enforces the hourly call cap", async () => {
    const now = new Date().toISOString();
    const { db, tables } = makeDb({
      agents: [agentRow({ max_calls_per_hour: 2 })],
      runs: [
        { id: 1, agent_id: "support.public", task: "a", status: "ok", created_at: now },
        { id: 2, agent_id: "support.public", task: "b", status: "error", created_at: now },
      ],
    });
    const execute = vi.fn(async () => ({}));
    const out = await runAgent(db, "support.public", { task: "ping", execute });
    expect(out).toMatchObject({ ok: false, status: "denied", reason: "hourly_call_cap" });
    expect(execute).not.toHaveBeenCalled();
    expect(tables.ai_agent_runs.filter((r) => r.status === "denied")).toHaveLength(1);
  });

  it("enforces daily budget when set", async () => {
    const today = new Date(); today.setUTCHours(12, 0, 0, 0);
    const { db } = makeDb({
      agents: [agentRow({ daily_budget_cents: 100 })],
      runs: [{ id: 1, agent_id: "support.public", task: "a", status: "ok", cost_cents: 100, created_at: today.toISOString() }],
    });
    const gate = await canRun(db, await getAgent(db, "support.public") as AgentRow);
    expect(gate).toEqual({ ok: false, reason: "daily_budget_exceeded" });
  });

  it("runs execute and records ok with duration", async () => {
    const { db, tables } = makeDb({ agents: [agentRow()] });
    const out = await runAgent(db, "support.public", { task: "hello", actor: "tester", execute: async () => ({ answer: 42 }) });
    expect(out).toMatchObject({ ok: true, status: "ok" });
    if (out.ok) expect(out.result).toEqual({ answer: 42 });
    const final = tables.ai_agent_runs.find((r) => r.status === "ok");
    expect(final).toMatchObject({ agent_id: "support.public", task: "hello", actor: "tester" });
    expect(final?.duration_ms).toBeTypeOf("number");
  });

  it("fails closed when the agent row lookup errors — no execute, warning event", async () => {
    const { recordLog, reportError } = await import("@/lib/observability");
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }) }) }) }),
    } as unknown as SupabaseClient;
    const execute = vi.fn(async () => ({}));
    const out = await runAgent(db, "support.public", { task: "ping", execute });
    expect(out).toMatchObject({ ok: false, status: "error", error: "agent_lookup_failed" });
    expect(execute).not.toHaveBeenCalled();
    expect(recordLog).toHaveBeenCalledWith("warning", "ai.authorization_unverifiable", expect.anything());
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ severity: "warning" }));
  });

  it("fails closed on a malformed agent row (enabled not a boolean)", async () => {
    const { db } = makeDb({ agents: [agentRow({ enabled: "yes" })] });
    const execute = vi.fn(async () => ({}));
    const out = await runAgent(db, "support.public", { task: "ping", execute });
    expect(out).toMatchObject({ ok: false, status: "error", error: "agent_lookup_failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("still denies (not errors) a well-formed disabled agent", async () => {
    const { db } = makeDb({ agents: [agentRow({ enabled: false })] });
    const execute = vi.fn(async () => ({}));
    const out = await runAgent(db, "support.public", { task: "ping", execute });
    expect(out).toMatchObject({ ok: false, status: "denied", reason: "agent_disabled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("records scrubbed error when execute throws", async () => {
    const { db, tables } = makeDb({ agents: [agentRow()] });
    const out = await runAgent(db, "support.public", {
      task: "boom",
      execute: async () => { throw new Error("call failed for pat@example.com token=sk-live-abcdef123456"); },
    });
    expect(out).toMatchObject({ ok: false, status: "error" });
    const err = tables.ai_agent_runs.find((r) => r.status === "error")?.error as string;
    expect(err).not.toContain("pat@example.com");
    expect(err).not.toContain("sk-live-abcdef123456");
    expect(scrubError("otp=123456 pan=4111111111111111")).not.toMatch(/123456|4111111111111111/);
  });
});

describe("approvals", () => {
  it("sanitizer strips secret-like keys and truncates long strings", () => {
    const clean = sanitizeApprovalPayload({
      amount_cents: 500,
      api_token: "sekret",
      nested: { password: "hunter2", note: "ok", card_number: "4111" },
      list: [{ otp: "0000", fine: true }],
      long: "x".repeat(900),
    });
    expect(clean.amount_cents).toBe(500);
    expect(clean).not.toHaveProperty("api_token");
    expect(clean.nested).toEqual({ note: "ok" });
    expect(clean.list).toEqual([{ fine: true }]);
    expect(String(clean.long).length).toBeLessThanOrEqual(501);
  });

  it("requestApproval stores a sanitized pending row", async () => {
    const { db, tables } = makeDb({ agents: [agentRow()] });
    const out = await requestApproval(db, { agentId: "support.public", action: "ticket.merge", payload: { secret_key: "nope", ticket: "Z-1" } });
    expect(out.ok).toBe(true);
    const row = tables.ai_approvals[0];
    expect(row.status).toBe("pending");
    expect(row.payload).toEqual({ ticket: "Z-1" });
  });

  it("denied actions can never be approved", async () => {
    const { db, tables } = makeDb({ agents: [agentRow()] });
    expect(DENIED_ACTIONS).toContain("refund.issue");
    const req = await requestApproval(db, { agentId: "support.public", action: "refund.issue", payload: { amount: 100 } });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    const approve = await decideApproval(db, req.id, "staff-1", true, "lgtm");
    expect(approve).toEqual({ ok: false, error: "action_not_approvable" });
    expect(tables.ai_approvals[0].status).toBe("pending");
    const reject = await decideApproval(db, req.id, "staff-1", false, "too risky");
    expect(reject).toEqual({ ok: true });
    expect(tables.ai_approvals[0].status).toBe("rejected");
  });

  it("normal actions can be approved once", async () => {
    const { db, tables } = makeDb({ agents: [agentRow()] });
    const req = await requestApproval(db, { agentId: "support.public", action: "ticket.tag", payload: {} });
    if (!req.ok) throw new Error("request failed");
    expect(await decideApproval(db, req.id, "not-a-uuid-dev-user", true)).toEqual({ ok: true });
    expect(tables.ai_approvals[0].status).toBe("approved");
    expect(tables.ai_approvals[0].decided_by).toBeNull(); // non-uuid staff id → null FK
    expect(await decideApproval(db, req.id, "x", true)).toEqual({ ok: false, error: "already_decided" });
  });
});

describe("updateAgent whitelist", () => {
  it("ignores id/department/name and applies whitelisted fields", async () => {
    const { db } = makeDb({ agents: [agentRow()] });
    const sneaky = { id: "evil.agent", department: "executive", name: "Hacked", model: "openai/gpt-4o", enabled: false, permissions: ["finance.reports.read"] } as never;
    const out = await updateAgent(db, "support.public", sneaky);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agent.id).toBe("support.public");
    expect(out.agent.department).toBe("support");
    expect(out.agent.name).toBe("Public");
    expect(out.agent.model).toBe("openai/gpt-4o");
    expect(out.agent.enabled).toBe(false);
    expect(out.agent.permissions).toEqual(["finance.reports.read"]);
  });

  it("rejects invalid field values", async () => {
    const { db } = makeDb({ agents: [agentRow()] });
    expect(await updateAgent(db, "support.public", { temperature: 9 })).toEqual({ ok: false, error: "invalid_temperature" });
    expect(await updateAgent(db, "support.public", { permissions: ["bad perm!"] })).toEqual({ ok: false, error: "invalid_permissions" });
    expect(await updateAgent(db, "support.public", {})).toEqual({ ok: false, error: "empty_patch" });
  });
});
