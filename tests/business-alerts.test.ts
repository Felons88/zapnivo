import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* reportError is the single emit mechanism — spy on it (same pattern as
 * system-alert-sweep-phase44.test.ts). */
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/observability")>();
  return { ...orig, reportError };
});

import {
  runAlertSweep,
  unreconciledPaymentIds,
  refundSpikeHit,
  payoutBacklogHit,
  rentalDeclineHit,
  inventoryMismatchKiosks,
  commissionDriftIds,
} from "@/lib/system/alert-sweep";

/* ── Stateful in-memory Supabase stub (supports head-count `count`) ── */

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
    private head = false;
    constructor(private name: string) {}
    select(_cols?: string, opts?: { head?: boolean }) { this.head = opts?.head === true; return this; }
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
      const filtered = rows.filter((r) => this.filters.every((f) => f(r)));
      const count = filtered.length;
      let out = filtered;
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: this.head ? null : out, error: null, count };
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
    then<T>(onF: (v: { data: unknown; error: unknown; count: number | null }) => T, onR?: (e: unknown) => T) {
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

/* ── Pure helpers ── */

describe("business probe pure helpers", () => {
  it("unreconciledPaymentIds flags only stuck pre-completion rentals + orphans", () => {
    const states = new Map<string, string | null>([
      ["r-stuck", "authorized"],
      ["r-cancelled", "cancelled"],
      ["r-active", "active"],
      ["r-closed", "closed"],
      ["r-overdue", "overdue"], // in-flight — settlement probe's job, not this one
      ["r-disputed", "disputed"],
    ]);
    const pays = [
      { id: "p1", rental_id: "r-stuck" },
      { id: "p2", rental_id: "r-cancelled" },
      { id: "p3", rental_id: "r-active" },
      { id: "p4", rental_id: "r-closed" },
      { id: "p5", rental_id: "r-overdue" },
      { id: "p6", rental_id: "r-disputed" },
      { id: "p7", rental_id: "r-missing" }, // orphaned payment
      { id: "p8", rental_id: null },       // event pass — not attributable
    ];
    expect(unreconciledPaymentIds(pays, states).sort()).toEqual(["p1", "p2", "p7"]);
  });

  it("refundSpikeHit requires both the absolute floor and the 3x heuristic", () => {
    expect(refundSpikeHit(2, 0)).toBe(false);    // below absolute floor
    expect(refundSpikeHit(3, 0)).toBe(true);     // floor met, zero baseline
    expect(refundSpikeHit(8, 20)).toBe(false);   // 8 <= 3*(20/7)≈8.57
    expect(refundSpikeHit(10, 20)).toBe(true);   // 10 > 8.57
    expect(refundSpikeHit(3, 7)).toBe(false);    // 3 > 3*(7/7)=3 is false (strict)
  });

  it("payoutBacklogHit ages approved from approved_at, scheduled from created_at", () => {
    const now = NOW.getTime();
    expect(payoutBacklogHit("approved", iso(8 * D), iso(30 * D), now)).toBe(true);
    expect(payoutBacklogHit("approved", iso(2 * D), iso(30 * D), now)).toBe(false); // approved_at wins over old created_at
    expect(payoutBacklogHit("approved", null, iso(8 * D), now)).toBe(true);        // created_at fallback
    expect(payoutBacklogHit("scheduled", null, iso(15 * D), now)).toBe(true);
    expect(payoutBacklogHit("scheduled", null, iso(10 * D), now)).toBe(false);
    expect(payoutBacklogHit("paid", null, iso(30 * D), now)).toBe(false);
    expect(payoutBacklogHit("cancelled", null, iso(30 * D), now)).toBe(false);
  });

  it("rentalDeclineHit needs a meaningful prior-week baseline", () => {
    expect(rentalDeclineHit(4, 10)).toBe(true);   // 4 < 5
    expect(rentalDeclineHit(5, 10)).toBe(false);  // exactly 50% — not a decline
    expect(rentalDeclineHit(1, 9)).toBe(false);   // baseline too small (noise guard)
    expect(rentalDeclineHit(0, 0)).toBe(false);
  });

  it("inventoryMismatchKiosks compares slot banks vs reported kiosk banks", () => {
    const slots = [
      { kiosk_id: "k1", state: "ready", power_bank_id: "b1" },
      { kiosk_id: "k1", state: "charging", power_bank_id: "b2" },
      { kiosk_id: "k1", state: "empty", power_bank_id: null },
      { kiosk_id: "k2", state: "ready", power_bank_id: "b3" },
      { kiosk_id: "k2", state: "fault", power_bank_id: "bX" }, // fault slot still holds a bank
    ];
    const banks = [
      { id: "b1", current_kiosk: "k1", retired: false },
      { id: "b2", current_kiosk: "k1", retired: false },
      { id: "b3", current_kiosk: "k2", retired: false },
      { id: "bX", current_kiosk: "k9", retired: false },  // slot says k2, bank says k9
      { id: "b9", current_kiosk: "k2", retired: false },  // reported but not docked
      { id: "bR", current_kiosk: "k1", retired: true },   // retired — ignored
    ];
    // k1: docked {b1,b2} vs reported {b1,b2} → match (retired bR ignored)
    // k2: docked {b3,bX} vs reported {b3,b9} (bX reports kiosk k9!) → diff = 2 → alert
    // k9: docked {} vs reported {bX} → diff = 1 ≤ tolerance → no alert
    expect(inventoryMismatchKiosks(slots, banks)).toEqual(["k2"]);
    // tolerance 0 → k9's single diff also alerts
    expect(inventoryMismatchKiosks(slots, banks, 0).sort()).toEqual(["k2", "k9"]);
  });

  it("commissionDriftIds only flags known-rate venues with a mismatch", () => {
    const ledgers = [
      { id: "l1", venue_id: "v1", gross_cents: 10000, commission_cents: 1500 },  // 15% → match
      { id: "l2", venue_id: "v1", gross_cents: 10000, commission_cents: 1000 },  // drift
      { id: "l3", venue_id: "v2", gross_cents: 10000, commission_cents: 999 },   // no rate → skip
    ];
    const pcts = new Map([["v1", 15]]);
    expect(commissionDriftIds(ledgers, pcts)).toEqual(["l2"]);
  });
});

/* ── Sweep integration ── */

describe("runAlertSweep — phase 6 business probes", () => {
  it("finance.unreconciled_captured: flags stuck rentals, skips in-flight", async () => {
    const db = fakeDb({
      payments: [
        { id: "pay-stuck", rental_id: "r1", amount_captured_cents: 500, captured_at: iso(72 * H) },
        { id: "pay-active", rental_id: "r2", amount_captured_cents: 500, captured_at: iso(72 * H) },
        { id: "pay-fresh", rental_id: "r3", amount_captured_cents: 500, captured_at: iso(2 * H) },   // too recent
        { id: "pay-norent", rental_id: null, amount_captured_cents: 500, captured_at: iso(72 * H) }, // event pass
        { id: "pay-orphan", rental_id: "r-gone", amount_captured_cents: 500, captured_at: iso(72 * H) },
      ],
      rentals: [
        { id: "r1", state: "authorized" },
        { id: "r2", state: "active" },
        { id: "r3", state: "closed" },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    const msgs = emittedMessages();
    expect(res.checks.unreconciled_captured).toEqual({ status: "ok", matched: 2, emitted: 2 });
    expect(msgs).toContain("finance.unreconciled_captured payment=pay-stuck window_hours=48 evidence=/admin/finance");
    expect(msgs).toContain("finance.unreconciled_captured payment=pay-orphan window_hours=48 evidence=/admin/finance");
    expect(msgs.some((m) => m.includes("pay-active"))).toBe(false);
    expect(msgs.some((m) => m.includes("pay-fresh"))).toBe(false);
    expect(msgs.some((m) => m.includes("pay-norent"))).toBe(false);
  });

  it("finance.refund_spike: fires only past floor + 3x trailing-7d average", async () => {
    const refunds = [
      // last 24h: 4 refunds — above floor
      ...Array.from({ length: 4 }, (_, i) => ({ id: `new-${i}`, created_at: iso((i + 1) * H) })),
      // baseline 7d before that: 2 refunds → avg 2/7 ≈ 0.29 → 4 > 0.86 → spike
      { id: "old-1", created_at: iso(2 * D) },
      { id: "old-2", created_at: iso(3 * D) },
    ];
    const res = await runAlertSweep(fakeDb({ refunds }), NOW);
    expect(res.checks.refund_spike).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(emittedMessages()).toContain("finance.refund_spike heuristic=trailing_7d evidence=/admin/support/refunds");

    reportError.mockClear();
    const calm = await runAlertSweep(fakeDb({
      refunds: [
        { id: "n1", created_at: iso(H) },
        ...Array.from({ length: 20 }, (_, i) => ({ id: `b-${i}`, created_at: iso((2 + i) * D) })), // heavy baseline
      ],
    }), NOW);
    expect(calm.checks.refund_spike).toEqual({ status: "ok", matched: 0, emitted: 0 });
    expect(emittedMessages().some((m) => m.includes("refund_spike"))).toBe(false);
  });

  it("finance.payout_backlog: approved >7d and scheduled >14d alert per record", async () => {
    const db = fakeDb({
      payout_records: [
        { id: "po-old-approved", status: "approved", created_at: iso(30 * D), approved_at: iso(8 * D) },
        { id: "po-fresh-approved", status: "approved", created_at: iso(30 * D), approved_at: iso(2 * D) },
        { id: "po-old-scheduled", status: "scheduled", created_at: iso(15 * D), approved_at: null },
        { id: "po-paid", status: "paid", created_at: iso(30 * D), approved_at: iso(20 * D) },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    const msgs = emittedMessages();
    expect(res.checks.payout_backlog).toEqual({ status: "ok", matched: 2, emitted: 2 });
    expect(msgs).toContain("finance.payout_backlog payout=po-old-approved status=approved evidence=/admin/payouts");
    expect(msgs).toContain("finance.payout_backlog payout=po-old-scheduled status=scheduled evidence=/admin/payouts");
    expect(msgs.some((m) => m.includes("po-fresh-approved") || m.includes("po-paid"))).toBe(false);
  });

  it("finance.commission_drift: venue agreement beats org; unknown rates skipped", async () => {
    const db = fakeDb({
      commission_ledgers: [
        { id: "led-ok", venue_id: "v1", period: "2026-02-01", gross_cents: 10000, commission_cents: 1500 },
        { id: "led-drift", venue_id: "v1", period: "2026-01-01", gross_cents: 10000, commission_cents: 1000 },
        { id: "led-norate", venue_id: "v2", period: "2026-01-01", gross_cents: 10000, commission_cents: 1 },
      ],
      partner_agreements: [
        { venue_id: "v1", organization_id: null, terms: { commission_pct: 15 } },
        { venue_id: null, organization_id: "org9", terms: { commission_pct: 10 } },
      ],
      venues: [
        { id: "v1", organization_id: "org9" }, // org pct exists but venue pct wins
        { id: "v2", organization_id: null },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    const msgs = emittedMessages();
    expect(res.checks.commission_drift).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(msgs).toContain("finance.commission_drift ledger=led-drift heuristic=latest_agreement_pct evidence=/admin/payouts");
    expect(msgs.some((m) => m.includes("led-norate"))).toBe(false);
  });

  it("ops.rental_decline: fires only with prior-7d >= 10 and <50% drop", async () => {
    // prior 7d (7–14d ago): 12 rentals, last 7d: 4 → decline
    const rentals = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `new-${i}`, created_at: iso((i + 1) * D) })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `old-${i}`, created_at: iso(7 * D + i * H) })),
    ];
    const res = await runAlertSweep(fakeDb({ rentals }), NOW);
    expect(res.checks.rental_decline).toEqual({ status: "ok", matched: 1, emitted: 1 });
    expect(emittedMessages()).toContain("ops.rental_decline window_days=7 evidence=/admin/rentals");

    reportError.mockClear();
    // tiny baseline: 2 prior, 1 recent → no alert (noise guard)
    const tiny = await runAlertSweep(fakeDb({
      rentals: [
        { id: "a", created_at: iso(D) },
        { id: "b", created_at: iso(9 * D) },
        { id: "c", created_at: iso(10 * D) },
      ],
    }), NOW);
    expect(tiny.checks.rental_decline).toEqual({ status: "ok", matched: 0, emitted: 0 });
    expect(emittedMessages().some((m) => m.includes("rental_decline"))).toBe(false);
  });

  it("ops.inventory_mismatch: per-kiosk slot↔bank drift beyond tolerance", async () => {
    const db = fakeDb({
      kiosk_slots: [
        { kiosk_id: "k-bad", slot_number: 1, state: "ready", power_bank_id: "b1" },
        { kiosk_id: "k-bad", slot_number: 2, state: "charging", power_bank_id: "b2" },
        { kiosk_id: "k-ok", slot_number: 1, state: "ready", power_bank_id: "b3" },
      ],
      power_banks: [
        { id: "b1", current_kiosk: "k-bad", retired: false },
        { id: "b2", current_kiosk: "k-other", retired: false }, // bank reports elsewhere → 2 diffs on k-bad
        { id: "b3", current_kiosk: "k-ok", retired: false },
      ],
    });
    const res = await runAlertSweep(db, NOW);
    const msgs = emittedMessages();
    // k-bad: docked {b1,b2} vs reported {b1} → diff 1 (b2) ... plus k-other reported {b2}
    // k-other: docked {} vs reported {b2} → diff 1. Both ≤ tolerance 1 → NO alert.
    expect(res.checks.inventory_mismatch).toEqual({ status: "ok", matched: 0, emitted: 0 });

    reportError.mockClear();
    // add a second stray bank on k-bad → diff 2 > tolerance → alert
    const worse = fakeDb({
      kiosk_slots: [
        { kiosk_id: "k-bad", slot_number: 1, state: "ready", power_bank_id: "b1" },
        { kiosk_id: "k-bad", slot_number: 2, state: "charging", power_bank_id: "b2" },
      ],
      power_banks: [
        { id: "b1", current_kiosk: "k-bad", retired: false },
        { id: "b2", current_kiosk: "k-other", retired: false },
        { id: "b7", current_kiosk: "k-bad", retired: false }, // reported, not docked → diff 2 on k-bad
      ],
    });
    const res2 = await runAlertSweep(worse, NOW);
    expect(res2.checks.inventory_mismatch?.status).toBe("ok");
    const msgs2 = emittedMessages();
    expect(msgs2).toContain("ops.inventory_mismatch kiosk=k-bad evidence=/admin/fleet");
    // k-other still only diff 1 → no alert
    expect(msgs2.some((m) => m.includes("kiosk=k-other"))).toBe(false);
  });

  it("phase-6 probes skip honestly when tables are missing", async () => {
    const base = fakeDb({});
    const realFrom = (base as unknown as { from: (t: string) => unknown }).from;
    const missing = new Set([
      "payments", "rentals", "refunds", "payout_records",
      "commission_ledgers", "partner_agreements", "venues",
      "kiosk_slots", "power_banks",
    ]);
    const db = {
      from: (t: string) => {
        if (missing.has(t)) {
          const err = { data: null, error: { message: `relation "${t}" does not exist` }, count: null };
          const chain: Record<string, unknown> = {};
          for (const m of ["select", "eq", "in", "gt", "gte", "lt", "lte", "is", "not", "order", "limit", "insert", "update"]) chain[m] = () => chain;
          chain.then = (res: (v: typeof err) => unknown) => Promise.resolve(err).then(res);
          return chain;
        }
        return realFrom(t);
      },
    } as unknown as SupabaseClient;
    const res = await runAlertSweep(db, NOW);
    for (const name of [
      "unreconciled_captured", "refund_spike", "payout_backlog",
      "commission_drift", "rental_decline", "inventory_mismatch",
    ]) {
      expect(res.checks[name]?.status).toBe("skipped");
    }
    expect(res.ok).toBe(true);
  });
});
