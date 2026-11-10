import { describe, expect, it } from "vitest";
import {
  computeSummary, groupByVenue, normalizePayment, parsePeriodDays, periodWindow,
  stripeFeeEstimateCents, summarizePayments, summarizePayouts, venuePctMap,
  type FinancePayment, type FinanceRefund,
} from "../src/lib/admin-finance";

const venue = { id: "v1", name: "Tavern", organization_id: "org1" };
const pay = (over: Partial<FinancePayment>): FinancePayment => ({
  id: "p", rentalId: "r", state: "captured", amountCapturedCents: 0, amountRefundedCents: 0,
  capturedAt: "2026-01-10T00:00:00Z", rentalState: "returned", venue, ...over,
});
const win = { days: 30 as const, start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" };
const baseInput = {
  payments: [] as FinancePayment[], refunds: [] as FinanceRefund[], smsOutboundCount: 0,
  smsCostPerMessageCents: null, venuePcts: new Map<string, number>(),
  payouts: { scheduledCents: 0, paidCents: 0, scheduledCount: 0, paidCount: 0 },
  actualStripeFeesCents: null,
};

describe("period handling", () => {
  it("only accepts 7/30/90, defaults to 30", () => {
    expect(parsePeriodDays("7")).toBe(7); expect(parsePeriodDays("90")).toBe(90);
    expect(parsePeriodDays("14")).toBe(30); expect(parsePeriodDays(null)).toBe(30); expect(parsePeriodDays("abc")).toBe(30);
  });
  it("window is a rolling [start, end) ending now", () => {
    const w = periodWindow(7, new Date("2026-02-10T12:00:00Z"));
    expect(w.start).toBe("2026-02-03T12:00:00.000Z");
    expect(w.end).toBe("2026-02-10T12:00:00.000Z");
  });
});

describe("captured vs authorized", () => {
  it("authorized/released payments with no captured amount are never revenue", () => {
    const t = summarizePayments([
      pay({ id: "a", amountCapturedCents: 0, amountRefundedCents: 0, state: "authorized", capturedAt: null }),
      pay({ id: "b", amountCapturedCents: 0, state: "released" }),
      pay({ id: "c", amountCapturedCents: 500 }),
    ]);
    expect(t.paymentCount).toBe(1);
    expect(t.grossCapturedCents).toBe(500);
    expect(t.rentalRevenueCents).toBe(500);
  });

  it("classifies non-return rentals separately from rental revenue", () => {
    const t = summarizePayments([
      pay({ id: "r", amountCapturedCents: 800, rentalState: "returned" }),
      pay({ id: "f", amountCapturedCents: 1299, rentalState: "charged_off" }),
      pay({ id: "f2", amountCapturedCents: 500, rentalState: "non_return_fee_paid" }),
    ]);
    expect(t.rentalRevenueCents).toBe(800);
    expect(t.nonReturnFeeCents).toBe(1799);
    expect(t.nonReturnFeePaymentCount).toBe(2);
  });

  it("nets refunds per payment, never below zero", () => {
    const t = summarizePayments([
      pay({ amountCapturedCents: 1000, amountRefundedCents: 400 }),
      pay({ amountCapturedCents: 500, amountRefundedCents: 900 }),
    ]);
    expect(t.netCapturedCents).toBe(600);
  });

  it("stripe fee estimate is 2.9% + 30c per captured payment", () => {
    expect(stripeFeeEstimateCents(1000)).toBe(Math.round(29) + 30);
    expect(stripeFeeEstimateCents(0)).toBe(0);
    expect(stripeFeeEstimateCents(-5)).toBe(0);
    const t = summarizePayments([pay({ amountCapturedCents: 1000 }), pay({ amountCapturedCents: 2000 })]);
    expect(t.stripeFeesCents).toBe(stripeFeeEstimateCents(1000) + stripeFeeEstimateCents(2000));
  });
});

describe("computeSummary", () => {
  it("nets refunds, SMS, Stripe fees and venue share into net platform revenue", () => {
    const payments = [
      pay({ id: "p1", amountCapturedCents: 10000, amountRefundedCents: 2000, rentalState: "returned" }),
      pay({ id: "p2", amountCapturedCents: 5000, rentalState: "charged_off" }),
    ];
    const refunds = [{ id: "rf", amountCents: 1500, paymentId: "p1", venue }];
    const venuePcts = new Map([["v1", 20]]);
    const s = computeSummary({ ...baseInput, payments, refunds, venuePcts, smsOutboundCount: 10, smsCostPerMessageCents: 1 }, win);
    // rental 10000, fee 5000, refunds 1500, stripe est, sms 10, venue share on net (8000+5000=13000*20%=2600)
    const stripe = stripeFeeEstimateCents(10000) + stripeFeeEstimateCents(5000);
    expect(s.rentalRevenueCents).toBe(10000);
    expect(s.nonReturnFeeCents).toBe(5000);
    expect(s.refundsCents).toBe(1500);
    expect(s.smsCostCents).toBe(10);
    expect(s.smsCostTracked).toBe(true);
    expect(s.venueShareCents).toBe(2600);
    expect(s.venuesWithRate).toBe(1);
    expect(s.netPlatformCents).toBe(10000 + 5000 - 1500 - stripe - 10 - 2600);
    expect(s.stripeFeesEstimated).toBe(true);
  });

  it("SMS cost is null and flagged untracked when no rate is configured", () => {
    const s = computeSummary({ ...baseInput, payments: [pay({ amountCapturedCents: 1000 })], smsOutboundCount: 42 }, win);
    expect(s.smsCostCents).toBeNull();
    expect(s.smsCostTracked).toBe(false);
    expect(s.netPlatformCents).toBe(1000 - stripeFeeEstimateCents(1000)); // SMS excluded, flagged
  });

  it("uses actual billing_ledger fees when present instead of the estimate", () => {
    const s = computeSummary({ ...baseInput, payments: [pay({ amountCapturedCents: 10000 })], actualStripeFeesCents: 320 }, win);
    expect(s.stripeFeesCents).toBe(320);
    expect(s.stripeFeesEstimated).toBe(false);
  });

  it("venue share only applies with an explicit agreement rate and positive net", () => {
    const venuePcts = venuePctMap(
      [{ venue_id: "v1", organization_id: "org1", terms: { commission_pct: 25 } }, { venue_id: null, organization_id: "org2", terms: {} }],
      [{ id: "v1", organization_id: "org1" }, { id: "v2", organization_id: "org2" }],
    );
    expect(venuePcts.get("v1")).toBe(25);
    expect(venuePcts.has("v2")).toBe(false); // no rate → never defaulted
    const s = computeSummary({ ...baseInput, payments: [pay({ amountCapturedCents: 4000, amountRefundedCents: 1000 })], venuePcts }, win);
    expect(s.venueShareCents).toBe(Math.round(3000 * 0.25));
  });

  it("passes payout totals through untouched", () => {
    const payouts = summarizePayouts([
      { amount_cents: 12000, status: "scheduled" }, { amount_cents: 8000, status: "paid" },
      { amount_cents: 500, status: "failed" }, { amount_cents: null, status: "paid" },
    ]);
    expect(payouts).toEqual({ scheduledCents: 12000, paidCents: 8000, scheduledCount: 1, paidCount: 2 }); // null amount still a paid record
    const s = computeSummary({ ...baseInput, payouts }, win);
    expect(s.payouts.scheduledCents).toBe(12000);
  });
});

describe("groupByVenue", () => {
  it("groups captured payments and refunds per venue with honest zeros", () => {
    const v2 = { id: "v2", name: "Cafe", organization_id: null };
    const payments = [
      pay({ id: "p1", rentalId: "r1", amountCapturedCents: 1000, venue }),
      pay({ id: "p2", rentalId: "r2", amountCapturedCents: 2000, amountRefundedCents: 500, venue }),
      pay({ id: "p3", rentalId: "r3", amountCapturedCents: 700, venue: v2 }),
      pay({ id: "p4", amountCapturedCents: 9999, venue: null }), // no venue → excluded
      pay({ id: "p5", amountCapturedCents: 0, venue }),          // authorized → excluded
    ];
    const refunds: FinanceRefund[] = [
      { id: "x", amountCents: 300, paymentId: "p1", venue },
      { id: "y", amountCents: 100, paymentId: null, venue: null }, // orphan refund → no venue bucket
    ];
    const rows = groupByVenue({ payments, refunds, venuePcts: new Map([["v1", 10]]) });
    expect(rows).toHaveLength(2);
    const tavern = rows.find((r) => r.venueId === "v1")!;
    expect(tavern.rentalsCount).toBe(2);       // distinct rentals r1, r2
    expect(tavern.capturedCents).toBe(3000);
    // payment-level refund (500) + refunds-table row (300)
    expect(tavern.refundedCents).toBe(800);
    expect(tavern.netCents).toBe(2200);
    expect(tavern.venueShareCents).toBe(220);
    const cafe = rows.find((r) => r.venueId === "v2")!;
    expect(cafe.capturedCents).toBe(700);
    expect(cafe.venueShareCents).toBeNull();   // no rate → "No rate", never 0-faked
    expect(cafe.stripeFeesCents).toBe(stripeFeeEstimateCents(700));
  });
});

describe("normalizePayment", () => {
  it("flattens the nested rentals→kiosks→venues embed", () => {
    const p = normalizePayment({
      id: "p1", rental_id: "r1", state: "captured",
      amount_captured_cents: 1299, amount_refunded_cents: 0, captured_at: "2026-01-05T00:00:00Z",
      rentals: { id: "r1", state: "charged_off", kiosks: { venues: venue } },
    });
    expect(p.amountCapturedCents).toBe(1299);
    expect(p.rentalState).toBe("charged_off");
    expect(p.venue?.name).toBe("Tavern");
    expect(p.rentalId).toBe("r1");
  });
  it("tolerates array embeds and missing venue", () => {
    const p = normalizePayment({
      id: "p2", rental_id: null, state: "authorized",
      amount_captured_cents: null, amount_refunded_cents: null, captured_at: null,
      rentals: [{ id: "r9", state: "active", kiosks: [{ venues: null }] }],
    });
    expect(p.amountCapturedCents).toBe(0);
    expect(p.venue).toBeNull();
    expect(p.rentalId).toBe("r9");
  });
});
