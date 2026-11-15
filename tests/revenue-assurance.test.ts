import { describe, expect, it } from "vitest";
import {
  EXCEPTION_CAP, capExceptions, computeAssurance,
  detectCapturedWithoutEntitlement, detectCommissionMismatch, detectDuplicateCaptures,
  detectMissingPayoutReference, detectMissingSettlement, detectUnexpectedRefund,
  type AssuranceComputationInput, type DisputeRowLite, type LedgerRowLite,
  type PayoutRowLite, type RefundRowLite,
} from "../src/lib/revenue-assurance";
import { stripeFeeEstimateCents, type FinancePayment } from "../src/lib/admin-finance";

const venue = { id: "v1", name: "Tavern", organization_id: "org1" };
const pay = (over: Partial<FinancePayment>): FinancePayment => ({
  id: "p1", rentalId: "r1", state: "captured", amountCapturedCents: 1000, amountRefundedCents: 0,
  capturedAt: "2026-01-10T00:00:00Z", rentalState: "returned", venue, ...over,
});
const refund = (over: Partial<RefundRowLite>): RefundRowLite => ({ id: "ref1", paymentId: "p1", amountCents: 500, ...over });
const dispute = (over: Partial<DisputeRowLite>): DisputeRowLite => ({
  id: "d1", paymentId: "p1", stripeDisputeId: "dp_1", status: "needs_response", amountCents: 1000, openedAt: "2026-01-15T00:00:00Z", ...over,
});
const ledger = (over: Partial<LedgerRowLite>): LedgerRowLite => ({
  id: "l1", venueId: "v1", period: "2026-01-01", grossCents: 1000, commissionCents: 200, ...over,
});
const payout = (over: Partial<PayoutRowLite>): PayoutRowLite => ({
  id: "po1", ledgerId: "l1", amountCents: 200, status: "paid", providerReference: "ach-123", ...over,
});
const window = { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" };

const baseInput = (over: Partial<AssuranceComputationInput> = {}): AssuranceComputationInput => ({
  payments: [], refunds: [], disputes: [], ledgers: [], payouts: [],
  venuePcts: new Map([["v1", 20]]), window, now: new Date("2026-02-01T00:00:00Z"), ...over,
});

describe("detectCapturedWithoutEntitlement", () => {
  it("skips entitled rental states and uncaptured payments", () => {
    const out = detectCapturedWithoutEntitlement([
      pay({ id: "a", rentalState: "returned" }),
      pay({ id: "b", rentalState: "charged_off" }),
      pay({ id: "c", rentalState: "non_return_fee_paid" }),
      pay({ id: "d", amountCapturedCents: 0, rentalState: "authorized" }),
    ]);
    expect(out).toHaveLength(0);
  });
  it("flags pre-dispense states as critical", () => {
    const out = detectCapturedWithoutEntitlement([pay({ id: "x", rentalState: "authorized" })]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
    expect(out[0].kind).toBe("captured_without_entitlement");
  });
  it("flags cancelled as warning and unknown state as warning, null as info", () => {
    expect(detectCapturedWithoutEntitlement([pay({ id: "c", rentalState: "cancelled" })])[0].severity).toBe("warning");
    expect(detectCapturedWithoutEntitlement([pay({ id: "u", rentalState: "weird_state" })])[0].severity).toBe("warning");
    expect(detectCapturedWithoutEntitlement([pay({ id: "n", rentalState: null })])[0].severity).toBe("info");
  });
});

describe("detectDuplicateCaptures", () => {
  it("flags rentals with more than one captured payment", () => {
    const out = detectDuplicateCaptures([
      pay({ id: "a", rentalId: "r1", amountCapturedCents: 1000 }),
      pay({ id: "b", rentalId: "r1", amountCapturedCents: 500 }),
      pay({ id: "c", rentalId: "r2", amountCapturedCents: 700 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].entityId).toBe("r1");
    expect(out[0].detail).toContain("$15.00");
  });
  it("ignores uncaptured and rental-less payments", () => {
    const out = detectDuplicateCaptures([
      pay({ id: "a", rentalId: "r1", amountCapturedCents: 0 }),
      pay({ id: "b", rentalId: null, amountCapturedCents: 100 }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe("detectMissingSettlement", () => {
  const old = "2025-11-01T00:00:00Z"; // ~92 days before now
  it("flags old captures with no ledger coverage", () => {
    const out = detectMissingSettlement([pay({ id: "p", capturedAt: old })], [], [], { now: new Date("2026-02-01T00:00:00Z") });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
    expect(out[0].entityId).toBe("v1|2025-11");
  });
  it("flags ledger-covered captures whose ledger has no payout", () => {
    const out = detectMissingSettlement(
      [pay({ id: "p", capturedAt: old })],
      [ledger({ period: "2025-11-01" })],
      [],
      { now: new Date("2026-02-01T00:00:00Z") },
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("info");
    expect(out[0].kind).toBe("missing_settlement");
  });
  it("is clean when a payout covers the ledger, and skips recent captures", () => {
    const out = detectMissingSettlement(
      [pay({ id: "p", capturedAt: old }), pay({ id: "q", capturedAt: "2026-01-20T00:00:00Z" })],
      [ledger({ period: "2025-11-01" })],
      [payout({ ledgerId: "l1" })],
      { now: new Date("2026-02-01T00:00:00Z") },
    );
    expect(out).toHaveLength(0);
  });
  it("marks unattributed captures as info", () => {
    const out = detectMissingSettlement(
      [pay({ id: "p", capturedAt: old, venue: null })], [], [],
      { now: new Date("2026-02-01T00:00:00Z") },
    );
    expect(out[0].severity).toBe("info");
  });
});

describe("detectUnexpectedRefund", () => {
  it("flags refunds with no captured payment", () => {
    const out = detectUnexpectedRefund([refund({ id: "r1", paymentId: "missing" })], [pay({})]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("warning");
  });
  it("flags refunds against uncaptured payments", () => {
    const out = detectUnexpectedRefund([refund({ paymentId: "p1" })], [pay({ amountCapturedCents: 0 })]);
    expect(out).toHaveLength(1);
  });
  it("flags over-refunds as critical", () => {
    const out = detectUnexpectedRefund(
      [refund({ id: "r1", amountCents: 800 }), refund({ id: "r2", amountCents: 400 })],
      [pay({ amountCapturedCents: 1000 })],
    );
    const over = out.find((e) => e.severity === "critical");
    expect(over).toBeDefined();
    expect(over!.detail).toContain("$2.00"); // over by 1200-1000 cents
  });
  it("is clean when refunds stay within captured", () => {
    const out = detectUnexpectedRefund([refund({ amountCents: 400 })], [pay({ amountCapturedCents: 1000 })]);
    expect(out).toHaveLength(0);
  });
});

describe("detectCommissionMismatch", () => {
  it("passes when recomputation matches the ledger", () => {
    const res = detectCommissionMismatch([ledger({})], [pay({})], new Map([["v1", 20]]));
    expect(res.checked).toBe(1);
    expect(res.exceptions).toHaveLength(0);
  });
  it("flags mismatched commission", () => {
    const res = detectCommissionMismatch([ledger({ commissionCents: 999 })], [pay({})], new Map([["v1", 20]]));
    expect(res.exceptions).toHaveLength(1);
    expect(res.exceptions[0].severity).toBe("warning");
  });
  it("skips venues without a rate instead of flagging", () => {
    const res = detectCommissionMismatch([ledger({})], [pay({})], new Map());
    expect(res.checked).toBe(0);
    expect(res.skippedNoRate).toBe(1);
    expect(res.exceptions).toHaveLength(0);
  });
  it("only counts payments inside the ledger month", () => {
    const res = detectCommissionMismatch(
      [ledger({})],
      [pay({ id: "a" }), pay({ id: "b", capturedAt: "2026-02-01T00:00:00Z" })],
      new Map([["v1", 20]]),
    );
    // one payment in Jan → gross 1000 → commission 200 → matches ledger
    expect(res.exceptions).toHaveLength(0);
  });
});

describe("detectMissingPayoutReference", () => {
  it("flags paid payouts without a provider reference", () => {
    const out = detectMissingPayoutReference([
      payout({ id: "a", providerReference: null }),
      payout({ id: "b", providerReference: "  " }),
      payout({ id: "c", providerReference: "ach-9" }),
      payout({ id: "d", status: "scheduled", providerReference: null }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.kind === "missing_payout_reference")).toBe(true);
  });
});

describe("capExceptions", () => {
  it("caps items but reports the true total", () => {
    const list = Array.from({ length: EXCEPTION_CAP + 5 }, (_, i) => ({
      kind: "k", severity: "info" as const, entityType: "t", entityId: String(i), label: "l", detail: "d", href: "/",
    }));
    const { total, items } = capExceptions(list);
    expect(total).toBe(EXCEPTION_CAP + 5);
    expect(items).toHaveLength(EXCEPTION_CAP);
  });
});

describe("computeAssurance metrics", () => {
  it("computes gross, refunds, chargebacks, est. fees and net proceeds", () => {
    const { metrics } = computeAssurance(baseInput({
      payments: [
        pay({ id: "a", amountCapturedCents: 1000 }),
        pay({ id: "b", amountCapturedCents: 2000, capturedAt: "2026-01-20T00:00:00Z" }),
        pay({ id: "c", amountCapturedCents: 500, capturedAt: "2025-12-01T00:00:00Z" }), // outside window
      ],
      refunds: [refund({ amountCents: 300 })],
      disputes: [
        dispute({ id: "d1", status: "needs_response", amountCents: 1000 }),
        dispute({ id: "d2", status: "lost", amountCents: 500 }),
        dispute({ id: "d3", status: "won", amountCents: 700 }),
      ],
    }));
    expect(metrics.grossCapturedCents).toBe(3000);
    expect(metrics.totalRefundedCents).toBe(300);
    expect(metrics.chargebackCount).toBe(2);
    expect(metrics.chargebackCents).toBe(1500);
    expect(metrics.chargebacksWonCount).toBe(1);
    const fees = stripeFeeEstimateCents(1000) + stripeFeeEstimateCents(2000);
    expect(metrics.estimatedStripeFeesCents).toBe(fees);
    // net = 3000 - 300 - fees - lost(500)
    expect(metrics.netProceedsCents).toBe(3000 - 300 - fees - 500);
  });

  it("computes commission accrued/paid/outstanding for overlapping ledgers only", () => {
    const { metrics } = computeAssurance(baseInput({
      ledgers: [
        ledger({ id: "l1", period: "2026-01-01", commissionCents: 1000 }),
        ledger({ id: "l2", venueId: "v2", period: "2025-11-01", commissionCents: 9999 }), // outside window
      ],
      payouts: [
        payout({ ledgerId: "l1", amountCents: 400, status: "paid" }),
        payout({ ledgerId: "l1", amountCents: 600, status: "scheduled", providerReference: null }),
      ],
    }));
    expect(metrics.commissionAccruedCents).toBe(1000);
    expect(metrics.commissionPaidCents).toBe(400);
    expect(metrics.commissionOutstandingCents).toBe(600);
    expect(metrics.payoutScheduledCount).toBe(1);
  });

  it("floors outstanding at zero per ledger", () => {
    const { metrics } = computeAssurance(baseInput({
      ledgers: [ledger({ commissionCents: 100 })],
      payouts: [payout({ amountCents: 500, status: "paid" })],
    }));
    expect(metrics.commissionOutstandingCents).toBe(0);
    expect(metrics.commissionPaidCents).toBe(500);
  });
});

describe("computeAssurance unavailable states", () => {
  it("null refunds → refund metric null and check unavailable", () => {
    const { metrics, checks } = computeAssurance(baseInput({ refunds: null }));
    expect(metrics.totalRefundedCents).toBeNull();
    expect(metrics.netProceedsCents).toBeNull();
    const c = checks.find((x) => x.kind === "unexpected_refund")!;
    expect(c.status).toBe("unavailable");
    expect(c.reason).toBeTruthy();
  });
  it("null ledgers/payouts → commission metrics null and dependent checks unavailable", () => {
    const { metrics, checks } = computeAssurance(baseInput({ ledgers: null, payouts: null }));
    expect(metrics.commissionAccruedCents).toBeNull();
    expect(metrics.commissionOutstandingCents).toBeNull();
    for (const kind of ["missing_settlement", "commission_mismatch", "missing_payout_reference"] as const) {
      expect(checks.find((x) => x.kind === kind)!.status).toBe("unavailable");
    }
  });
  it("disputes null → chargeback metrics null but other checks still run", () => {
    const { metrics, checks } = computeAssurance(baseInput({ disputes: null }));
    expect(metrics.chargebackCount).toBeNull();
    expect(metrics.netProceedsCents).toBeNull();
    expect(checks.find((x) => x.kind === "duplicate_captures")!.status).toBe("ok");
  });
});

describe("computeAssurance checks wiring", () => {
  it("returns all six checks with ok status on clean input", () => {
    const { checks } = computeAssurance(baseInput({ payments: [pay({})] }));
    expect(checks.map((c) => c.kind).sort()).toEqual([
      "captured_without_entitlement", "commission_mismatch", "duplicate_captures",
      "missing_payout_reference", "missing_settlement", "unexpected_refund",
    ]);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });
  it("surfaces detector exceptions in the matching check", () => {
    const { checks } = computeAssurance(baseInput({
      payments: [pay({ id: "a", rentalState: "authorized" }), pay({ id: "b", rentalId: "r1" }), pay({ id: "c", rentalId: "r1" })],
    }));
    expect(checks.find((c) => c.kind === "captured_without_entitlement")!.total).toBe(1);
    expect(checks.find((c) => c.kind === "duplicate_captures")!.total).toBe(1);
  });
});
