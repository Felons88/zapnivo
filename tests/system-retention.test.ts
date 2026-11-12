import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runRetention, isPreservedTable, getRetentionRule, RETENTION_POLICY, PRESERVED_TABLES,
} from "@/lib/system/retention";

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };

type TableCalls = {
  filters: [string, ...unknown[]][];
  limits: number[];
  inserted: unknown[];
  deletedWith: unknown[] | null;
};

function fakeTable(opts: { select?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const calls: TableCalls = { filters: [], limits: [], inserted: [], deletedWith: null };
  const b: Record<string, unknown> & { _limit?: number } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };

  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "update", "upsert"]) {
    b[m] = (...a: unknown[]) => {
      if (["eq", "lt", "lte", "gte", "gt", "in", "is", "not"].includes(m)) calls.filters.push([m, ...a]);
      return b;
    };
  }
  b.limit = (n: number) => { b._limit = n; calls.limits.push(n); return b; };
  b.delete = () => {
    // delete().in("id", ids) — capture ids on the next .in() call
    const origIn = b.in as (...a: unknown[]) => unknown;
    b.in = (...a: unknown[]) => { calls.deletedWith = a[1] as unknown[]; return origIn(...a); };
    return b;
  };
  b.insert = (row: unknown) => { calls.inserted.push(row); return b; };
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => {
    const base = opts.select ?? { data: [], error: null, count: 0 };
    const data = Array.isArray(base.data) && b._limit != null ? base.data.slice(0, b._limit) : base.data;
    return Promise.resolve({ ...base, data }).then(res, rej);
  };
  (b as { _calls?: TableCalls })._calls = calls;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const callsOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _calls: TableCalls })._calls;

const actor = { id: "u-1", role: "sysadmin" };

describe("retention policy", () => {
  it("policy contains only telemetry tables; preserved list is non-empty", () => {
    expect(RETENTION_POLICY.length).toBeGreaterThanOrEqual(8);
    for (const r of RETENTION_POLICY) expect(isPreservedTable(r.table)).toBe(false);
    for (const t of ["system_audit_events", "incidents", "stripe_events", "payments", "profiles", "auth_sessions"]) {
      expect(isPreservedTable(t)).toBe(true);
    }
    expect(PRESERVED_TABLES).toContain("system_audit_events");
  });

  it("getRetentionRule resolves known tables only", () => {
    expect(getRetentionRule("error_events")?.retentionDays).toBe(30);
    expect(getRetentionRule("system_audit_events")).toBeNull();
    expect(getRetentionRule("nope")).toBeNull();
  });
});

describe("runRetention", () => {
  it("REFUSES preserved-class tables even in execute mode", async () => {
    const payments = fakeTable();
    const db = fakeDb({ payments, system_retention_runs: fakeTable({ singles: [{ data: { id: "run-1" }, error: null }] }), system_audit_events: fakeTable() });
    const report = await runRetention(db, { dryRun: false, table: "payments", actor });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/preserved/);
    expect(callsOf(payments).deletedWith).toBeNull();
    expect(callsOf(payments).inserted).toHaveLength(0);
  });

  it("dry-run counts but deletes nothing", async () => {
    const errorEvents = fakeTable({ select: { data: [], error: null, count: 42 } });
    const runs = fakeTable({ singles: [{ data: { id: "run-2" }, error: null }] });
    const db = fakeDb({ error_events: errorEvents, system_retention_runs: runs });
    const report = await runRetention(db, { dryRun: true, table: "error_events", actor });
    expect(report.ok).toBe(true);
    const res = report.results[0];
    expect(res.table).toBe("error_events");
    expect(res.matched).toBe(42);
    expect(res.deleted).toBe(0);
    expect(res.dryRun).toBe(true);
    expect(callsOf(errorEvents).deletedWith).toBeNull();
    // run history still recorded, mode dry_run
    const runInsert = callsOf(runs).inserted[0] as Record<string, unknown>;
    expect(runInsert.mode).toBe("dry_run");
    expect(runInsert.status).toBe("completed");
    expect(report.runId).toBe("run-2");
  });

  it("execute deletes bounded id batches (limit honored)", async () => {
    const appLogs = fakeTable({
      select: { data: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }], error: null },
    });
    const db = fakeDb({ app_logs: appLogs, system_retention_runs: fakeTable({ singles: [{ data: { id: "run-3" }, error: null }] }) });
    const report = await runRetention(db, { dryRun: false, table: "app_logs", limit: 2, actor });
    const res = report.results[0];
    expect(res.deleted).toBe(2);
    expect(res.matched).toBe(2);
    expect(callsOf(appLogs).limits).toContain(2);
    expect(callsOf(appLogs).deletedWith).toEqual(["a", "b"]);
  });

  it("applies status filters for queue-style tables", async () => {
    const inbound = fakeTable({ select: { data: [{ id: "j1" }], error: null } });
    const db = fakeDb({ inbound_jobs: inbound, system_retention_runs: fakeTable({ singles: [{ data: { id: "r" }, error: null }] }) });
    await runRetention(db, { dryRun: false, table: "inbound_jobs", actor });
    const filters = callsOf(inbound).filters;
    expect(filters).toContainEqual(["eq", "status", "done"]);
    expect(filters.some((f) => f[0] === "lt" && f[1] === "created_at")).toBe(true);
  });

  it("records deleted_counts + duration in system_retention_runs", async () => {
    const logs = fakeTable({ select: { data: [{ id: 1 }, { id: 2 }], error: null } });
    const runs = fakeTable({ singles: [{ data: { id: "run-9" }, error: null }] });
    const db = fakeDb({ app_logs: logs, system_retention_runs: runs });
    const report = await runRetention(db, { dryRun: false, table: "app_logs", actor });
    expect(report.ok).toBe(true);
    const row = callsOf(runs).inserted[0] as Record<string, unknown>;
    expect(row.mode).toBe("execute");
    expect(row.deleted_counts).toEqual({ app_logs: 2 });
    expect(typeof row.duration_ms).toBe("number");
    expect(row.tables).toEqual(["app_logs"]);
  });

  it("skips missing tables honestly (e.g. system_device_messages pre-0044)", async () => {
    const missing = fakeTable({ select: { data: null, error: { message: 'relation "public.system_device_messages" does not exist' }, count: null } });
    const runs = fakeTable({ singles: [{ data: { id: "run-s" }, error: null }] });
    const db = fakeDb({ system_device_messages: missing, system_retention_runs: runs });
    const report = await runRetention(db, { dryRun: true, table: "system_device_messages", actor });
    expect(report.results[0].skipped).toBe(true);
    expect(report.ok).toBe(true); // skipped is not a hard failure
  });

  it("rejects unknown table names", async () => {
    const db = fakeDb({});
    const report = await runRetention(db, { dryRun: true, table: "definitely_not_a_table", actor });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/unknown retention table/);
  });
});
