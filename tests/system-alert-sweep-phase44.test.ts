import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* reportError is the single emit mechanism — spy on it (same pattern as
 * alert-sweep-phase4.test.ts). */
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/observability")>();
  return { ...orig, reportError };
});

import { runAlertSweep } from "@/lib/system/alert-sweep";

/* ── Stateful in-memory Supabase stub ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert() { return this; }
    update() { return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }
    private run() {
      const rows = ensure(this.name);
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    single() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return Promise.resolve({ data: rows[0] ?? null, error: rows.length ? null : { message: "0 rows" } });
    }
    maybeSingle() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }
  return { from: (t: string) => new QB(t) } as unknown as SupabaseClient;
}

const NOW = new Date("2026-03-01T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;
const D = 24 * H;

const emittedMessages = () => reportError.mock.calls.map((c) => String((c[0] as Error).message));

beforeEach(() => reportError.mockClear());

describe("runAlertSweep — phase 4.4 probes", () => {
  it("update.rollout_failure: failed targets alert; firmware kind gets its own rule", async () => {
    const db = fakeDb({
      kiosk_update_targets: [
        { id: "t-sw", campaign_id: "c1", device_id: "d1", state: "failed", updated_at: iso(H), state_entered_at: iso(H) },
        { id: "t-fw", campaign_id: "c2", device_id: "d2", state: "unknown_outcome", updated_at: iso(2 * H), state_entered_at: iso(2 * H) },
        { id: "t-old", campaign_id: "c1", device_id: "d3", state: "failed", updated_at: iso(48 * H), state_entered_at: iso(48 * H) },
        { id: "t-ok", campaign_id: "c1", device_id: "d4", state: "completed", updated_at: iso(H), state_entered_at: iso(H) },
      ],
      kiosk_update_campaigns: [
        { id: "c1", release_id: "r1" }, { id: "c2", release_id: "r2" },
      ],
      kiosk_update_releases: [
        { id: "r1", kind: "software" }, { id: "r2", kind: "firmware" },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    const msgs = emittedMessages();
    expect(res.checks.update_rollout_failures).toEqual({ status: "ok", matched: 2, emitted: 2 });
    expect(msgs).toContain("update.rollout_failure target=t-sw kind=software state=failed");
    expect(msgs).toContain("firmware.rollout_failure target=t-fw state=unknown_outcome");
    expect(msgs.some((m) => m.includes("t-old"))).toBe(false); // stale
    expect(msgs.some((m) => m.includes("t-ok"))).toBe(false);  // not a failure state
  });

  it("update.campaign_blocked: alerts per recently-blocked campaign", async () => {
    const db = fakeDb({
      kiosk_update_campaigns: [
        { id: "camp-1", status: "blocked", updated_at: iso(H) },
        { id: "camp-2", status: "blocked", updated_at: iso(72 * H) }, // outside 24h window
        { id: "camp-3", status: "active", updated_at: iso(H) },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    expect(res.checks.update_campaign_blocked).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(emittedMessages()).toContain("update.campaign_blocked campaign=camp-1");
  });

  it("config.drift_detected: mismatched reported config alerts per device; unreported is not drift", async () => {
    const db = fakeDb({
      device_config_revisions: [
        // device d1: latest revision (2) mismatches
        { device_id: "d1", revision: 1, desired: { volume: 5 }, status: "applied", reported: { volume: 5 } },
        { device_id: "d1", revision: 2, desired: { volume: 9 }, status: "awaiting_report", reported: { volume: 3 } },
        // device d2: reported === null → unreported, NOT drift
        { device_id: "d2", revision: 1, desired: { volume: 5 }, status: "awaiting_report", reported: null },
        // device d3: reported matches → no drift
        { device_id: "d3", revision: 1, desired: { volume: 5 }, status: "applied", reported: { volume: 5 } },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    expect(res.checks.config_drift).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(emittedMessages()).toContain("config.drift_detected device=d1");
  });

  it("finance.reconciliation_error: error app_logs mentioning reconcil emit one stable alert", async () => {
    const db = fakeDb({
      app_logs: [
        { id: 1, level: "error", message: "rental_refund_reconcile_failed", ts: iso(H) },
        { id: 2, level: "error", message: "rental_refund_reconcile_failed", ts: iso(2 * H) },
        { id: 3, level: "info", message: "nonreturn_fee_refund_reconciled", ts: iso(H) }, // not error level
        { id: 4, level: "error", message: "unrelated crash", ts: iso(H) },
        { id: 5, level: "error", message: "rental_refund_reconcile_failed", ts: iso(48 * H) }, // outside window
      ],
    });
    const res = await runAlertSweep(db, NOW);
    expect(res.checks.finance_reconciliation).toEqual({ status: "ok", matched: 2, emitted: 1 });
    expect(emittedMessages()).toContain("finance.reconciliation_error source=app_logs");
    expect(emittedMessages().filter((m) => m.includes("reconciliation_error"))).toHaveLength(1);
  });

  it("recovery.test_overdue: empty table and stale tests alert; fresh test does not", async () => {
    const empty = await runAlertSweep(fakeDb({ system_recovery_tests: [] }), NOW);
    expect(empty.checks.recovery_test_overdue).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(emittedMessages()).toContain("recovery.test_overdue window_days=90");

    reportError.mockClear();
    const stale = await runAlertSweep(fakeDb({
      system_recovery_tests: [{ tested_at: iso(100 * D) }],
    }), NOW);
    const check = stale.checks.recovery_test_overdue;
    expect(check.status).toBe("ok");
    if (check.status === "ok") expect(check.emitted).toBe(1);

    reportError.mockClear();
    const fresh = await runAlertSweep(fakeDb({
      system_recovery_tests: [{ tested_at: iso(10 * D) }],
    }), NOW);
    expect(fresh.checks.recovery_test_overdue).toEqual({ status: "ok", matched: 0, emitted: 0 });
    expect(emittedMessages().some((m) => m.includes("recovery.test_overdue"))).toBe(false);
  });

  it("new probes skip honestly when tables are missing", async () => {
    // fakeDb returns empty rows for unknown tables — to simulate a missing
    // table we need an erroring db; use a db whose from() throws for the
    // phase-4.4 tables only.
    const base = fakeDb({});
    const realFrom = (base as unknown as { from: (t: string) => unknown }).from;
    const missing = new Set(["kiosk_update_targets", "kiosk_update_campaigns", "kiosk_update_releases", "device_config_revisions", "app_logs", "system_recovery_tests"]);
    const db = {
      from: (t: string) => {
        if (missing.has(t)) {
          const err = { data: null, error: { message: `relation "${t}" does not exist` } };
          const chain: Record<string, unknown> = {};
          for (const m of ["select", "eq", "in", "gte", "lt", "lte", "is", "not", "order", "limit", "insert", "update"]) chain[m] = () => chain;
          chain.then = (res: (v: typeof err) => unknown) => Promise.resolve(err).then(res);
          return chain;
        }
        return realFrom(t);
      },
    } as unknown as SupabaseClient;
    const res = await runAlertSweep(db, NOW);
    for (const name of ["update_rollout_failures", "update_campaign_blocked", "config_drift", "finance_reconciliation", "recovery_test_overdue"]) {
      expect(res.checks[name]?.status).toBe("skipped");
    }
    expect(res.ok).toBe(true);
  });
});
