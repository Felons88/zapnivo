import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listPendingApprovals, approvalSummary } from "@/lib/system/approvals";

/* Fake db: records the eq("status","pending") filter and returns canned rows. */
function fakeDb(rows: Record<string, unknown>[], calls: { method: string; args: unknown[] }[] = []) {
  return {
    from(table: string) {
      expect(table).toBe("system_change_requests");
      const b: Record<string, unknown> = {};
      const rec = (m: string) => (...a: unknown[]) => { calls.push({ method: m, args: a }); return b; };
      for (const m of ["select", "eq", "order", "limit", "in", "like"]) b[m] = rec(m);
      b.then = (res: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(res);
      return b;
    },
  } as unknown as SupabaseClient;
}

const cr = (id: string, risk: string, created_at: string, requested_by = "req-1") => ({
  id, action: "deploy.api", environment: "production", risk, justification: "why",
  status: "pending", requested_by, decided_by: null, decided_at: null, result: null, created_at,
});

describe("listPendingApprovals", () => {
  it("returns configured:false for null db", async () => {
    expect((await listPendingApprovals(null)).configured).toBe(false);
  });

  it("filters to pending and computes age in hours", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const db = fakeDb([cr("c1", "high", old)], calls);
    const { rows, configured } = await listPendingApprovals(db);
    expect(configured).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].ageHours).toBeGreaterThanOrEqual(4);
    const eqCall = calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["status", "pending"]);
  });
});

describe("approvalSummary", () => {
  it("counts pending by risk and finds oldest", async () => {
    const t = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const oldest = t(10);
    const db = fakeDb([cr("a", "critical", oldest), cr("b", "high", t(2)), cr("c", "high", t(1)), cr("d", "low", t(0))]);
    const s = await approvalSummary(db);
    expect(s?.pending).toBe(4);
    expect(s?.byRisk.critical).toBe(1);
    expect(s?.byRisk.high).toBe(2);
    expect(s?.byRisk.low).toBe(1);
    expect(s?.oldestPendingAt).toBe(oldest);
  });

  it("returns null on null db", async () => {
    expect(await approvalSummary(null)).toBeNull();
  });
});
