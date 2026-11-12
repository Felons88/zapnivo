import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getRecoveryFacts, recordRecoveryTest, listRecoveryTests, isRecoveryMethod, RESTORE_RUNBOOK,
} from "@/lib/system/recovery";

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(opts: { singles?: Result[]; select?: Result } = {}) {
  const singles = [...(opts.singles ?? [])];
  const calls = { inserted: [] as unknown[], filters: [] as unknown[][] };
  const b: Record<string, unknown> = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "update", "upsert", "delete"]) {
    b[m] = () => b;
  }
  b.eq = (...a: unknown[]) => { calls.filters.push(a); return b; };
  b.limit = () => b;
  b.insert = (row: unknown) => { calls.inserted.push(row); return b; };
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.select ?? { data: [], error: null }).then(res, rej);
  (b as { _calls?: typeof calls })._calls = calls;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const callsOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _calls: { inserted: unknown[]; filters: unknown[][] } })._calls;

const actor = { id: "sec-1", role: "security" };

describe("recovery facts are honest", () => {
  it("never claims verified backups — provider-managed + unverified", () => {
    const f = getRecoveryFacts();
    expect(f.backupStatus).toBe("managed_by_provider_unverified");
    expect(f.pitrStatus).toBe("unverified");
    expect(f.rpoTargetMinutes).toBeNull();
    expect(f.rtoTargetMinutes).toBeNull();
    expect(f.backupDetail).toMatch(/cannot be verified|Supabase dashboard/i);
  });

  it("runbook warns against blind production restores", () => {
    const warnings = RESTORE_RUNBOOK.filter((s) => s.warning);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(RESTORE_RUNBOOK.some((s) => /never restore over production/i.test(`${s.title} ${s.detail}`))).toBe(true);
  });

  it("validates method names", () => {
    expect(isRecoveryMethod("supabase_pitr")).toBe(true);
    expect(isRecoveryMethod("carrier_pigeon")).toBe(false);
  });
});

describe("recordRecoveryTest", () => {
  const testRow = {
    id: "t-1", tested_at: new Date().toISOString(), environment: "production",
    method: "supabase_pitr", result: "passed", rpo_minutes: 15, rto_minutes: 42,
    notes: "restored to scratch project, verified payments", actor_id: "sec-1",
    created_at: new Date().toISOString(),
  };

  it("inserts the test row with actor + writes an audit event", async () => {
    const tests = fakeTable({ singles: [{ data: testRow, error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_recovery_tests: tests, system_audit_events: audit });
    const res = await recordRecoveryTest(db, actor, {
      environment: "production", method: "supabase_pitr", result: "passed",
      rpoMinutes: 15, rtoMinutes: 42, notes: "restored to scratch project, verified payments",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.test.id).toBe("t-1");
    const ins = callsOf(tests).inserted[0] as Record<string, unknown>;
    expect(ins.actor_id).toBe("sec-1");
    expect(ins.result).toBe("passed");
    expect(ins.rpo_minutes).toBe(15);
    expect(ins.rto_minutes).toBe(42);
    const auditRow = callsOf(audit).inserted[0] as Record<string, unknown>;
    expect(auditRow.action).toBe("recovery.test_recorded");
    expect(auditRow.resource).toBe("recovery_test:t-1");
  });

  it("rejects insert failures honestly", async () => {
    const tests = fakeTable({ singles: [{ data: null, error: { message: "insert failed" } }] });
    const db = fakeDb({ system_recovery_tests: tests, system_audit_events: fakeTable() });
    const res = await recordRecoveryTest(db, actor, { result: "failed" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
  });
});

describe("listRecoveryTests", () => {
  it("returns rows newest-first", async () => {
    const tests = fakeTable({ select: { data: [testRowPublic()], error: null } });
    function testRowPublic() { return { id: "t-1", tested_at: "2025-01-01T00:00:00Z", environment: "production", method: "m", result: "passed", rpo_minutes: null, rto_minutes: null, notes: null, actor_id: null, created_at: "2025-01-01T00:00:00Z" }; }
    const db = fakeDb({ system_recovery_tests: tests });
    const { tests: rows, error } = await listRecoveryTests(db);
    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("t-1");
  });

  it("treats a missing table (pre-0045) as empty, not an error", async () => {
    const tests = fakeTable({ select: { data: null, error: { message: 'relation "public.system_recovery_tests" does not exist' } } });
    const db = fakeDb({ system_recovery_tests: tests });
    const { tests: rows, error } = await listRecoveryTests(db);
    expect(rows).toEqual([]);
    expect(error).toBeNull();
  });
});
