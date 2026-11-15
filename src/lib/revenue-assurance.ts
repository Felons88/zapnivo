import type { SupabaseClient } from "@supabase/supabase-js";
import {
  NON_RETURN_RENTAL_STATES, normalizePayment, periodWindow, stripeFeeEstimateCents,
  venuePctMap, type FinancePayment, type PeriodDays, type VenuePctMap,
} from "./admin-finance";
import { computeLedger } from "./ledgers";

/**
 * Revenue assurance — reconciliation between money captured, money refunded,
 * chargebacks, Stripe fees (estimate only), and partner commission settlement.
 *
 * Honesty rules:
 *  - Stripe fees are ALWAYS an estimate (2.9% + $0.30 per capture) — labelled everywhere.
 *  - "Settled" means a commission ledger covers the capture's venue+month AND a
 *    payout record exists for that ledger. We never invent settlement amounts.
 *  - Any check whose inputs can't be loaded reports status 'unavailable' with a
 *    reason — never a silent zero.
 */

export const EXCEPTION_CAP = 100;
export const MISSING_SETTLEMENT_AGE_DAYS = 45;

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssuranceSeverity = "info" | "warning" | "critical";

export type ReassuranceException = {
  kind: string;
  severity: AssuranceSeverity;
  entityType: string;
  entityId: string;
  label: string;
  detail: string;
  href: string;
};

export type AssuranceCheckKind =
  | "captured_without_entitlement"
  | "duplicate_captures"
  | "missing_settlement"
  | "unexpected_refund"
  | "commission_mismatch"
  | "missing_payout_reference";

export type AssuranceCheck = {
  kind: AssuranceCheckKind;
  label: string;
  status: "ok" | "unavailable";
  reason?: string;
  total: number;
  items: ReassuranceException[]; // capped at EXCEPTION_CAP
};

export type AssuranceMetrics = {
  grossCapturedCents: number | null;
  totalRefundedCents: number | null; // refunds issued within the window
  chargebackCount: number | null; // open + lost disputes
  chargebackCents: number | null;
  chargebacksOpenCount: number | null;
  chargebacksOpenCents: number | null;
  chargebacksLostCount: number | null;
  chargebacksLostCents: number | null;
  chargebacksWonCount: number | null;
  estimatedStripeFeesCents: number | null; // ESTIMATE — never actuals
  netProceedsCents: number | null; // gross − refunds − est. fees − lost chargebacks
  commissionAccruedCents: number | null;
  commissionPaidCents: number | null;
  commissionOutstandingCents: number | null;
  payoutScheduledCount: number | null;
};

export type RevenueAssurance = {
  window: { days: PeriodDays; start: string; end: string };
  metrics: AssuranceMetrics;
  checks: AssuranceCheck[];
};

// ─── Row shapes (kept minimal so detectors are pure + unit-testable) ──────────

export type RefundRowLite = { id: string; paymentId: string | null; amountCents: number };
export type DisputeRowLite = { id: string; paymentId: string | null; stripeDisputeId: string | null; status: string | null; amountCents: number; openedAt: string | null };
export type LedgerRowLite = { id: string; venueId: string; period: string; grossCents: number; commissionCents: number };
export type PayoutRowLite = { id: string; ledgerId: string; amountCents: number; status: string; providerReference: string | null };

// ─── Pure detectors ────────────────────────────────────────────────────────────

/** Rental states where a captured payment maps to delivered/owed service or a non-return fee. */
const ENTITLED_RENTAL_STATES = new Set([
  ...NON_RETURN_RENTAL_STATES,
  "active", "returned", "return_pending", "overdue", "unreturned", "closed", "disputed",
]);
/** States proving no service was ever delivered — capture here is a real anomaly. */
const PRE_DISPENSE_STATES = new Set(["authorized", "dispense_pending", "pending_payment", "payment_authorized"]);

const HREF_INVESTIGATIONS = "/admin/finance/investigations";
const HREF_PAYOUTS = "/admin/payouts";
const HREF_RENTALS = "/admin/rentals";

const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

export function capExceptions(list: ReassuranceException[]): { total: number; items: ReassuranceException[] } {
  return { total: list.length, items: list.slice(0, EXCEPTION_CAP) };
}

/** Captured money on a rental that never reached an entitled state. */
export function detectCapturedWithoutEntitlement(payments: FinancePayment[]): ReassuranceException[] {
  const out: ReassuranceException[] = [];
  for (const p of payments) {
    if (p.amountCapturedCents <= 0) continue;
    const rs = p.rentalState;
    if (rs != null && ENTITLED_RENTAL_STATES.has(rs)) continue;
    if (rs == null) {
      out.push({
        kind: "captured_without_entitlement", severity: "info", entityType: "payment", entityId: p.id,
        label: `Payment ${p.id.slice(0, 8)}`, detail: `Captured ${cents(p.amountCapturedCents)} but the linked rental state is unknown — verify the rental exists.`,
        href: HREF_INVESTIGATIONS,
      });
    } else if (PRE_DISPENSE_STATES.has(rs)) {
      out.push({
        kind: "captured_without_entitlement", severity: "critical", entityType: "payment", entityId: p.id,
        label: `Payment ${p.id.slice(0, 8)}`, detail: `Captured ${cents(p.amountCapturedCents)} while rental is '${rs}' — no service was delivered. Likely needs refund or escalation.`,
        href: HREF_INVESTIGATIONS,
      });
    } else {
      out.push({
        kind: "captured_without_entitlement", severity: "warning", entityType: "payment", entityId: p.id,
        label: `Payment ${p.id.slice(0, 8)}`, detail: `Captured ${cents(p.amountCapturedCents)} on a rental in state '${rs}' — outside the entitled states.`,
        href: HREF_RENTALS,
      });
    }
  }
  return out;
}

/** More than one captured payment against the same rental (may be charge + non-return fee — verify). */
export function detectDuplicateCaptures(payments: FinancePayment[]): ReassuranceException[] {
  const byRental = new Map<string, FinancePayment[]>();
  for (const p of payments) {
    if (p.amountCapturedCents <= 0 || !p.rentalId) continue;
    const arr = byRental.get(p.rentalId) ?? [];
    arr.push(p); byRental.set(p.rentalId, arr);
  }
  const out: ReassuranceException[] = [];
  for (const [rentalId, pays] of byRental) {
    if (pays.length < 2) continue;
    const total = pays.reduce((a, p) => a + p.amountCapturedCents, 0);
    out.push({
      kind: "duplicate_captures", severity: "warning", entityType: "rental", entityId: rentalId,
      label: `Rental ${rentalId.slice(0, 8)}`,
      detail: `${pays.length} captured payments totalling ${cents(total)} — may be a rental charge plus a non-return fee; verify no double charge.`,
      href: HREF_INVESTIGATIONS,
    });
  }
  return out;
}

const monthKey = (iso: string) => iso.slice(0, 7);

/**
 * Captured payments older than `olderThanDays` with no commission-ledger coverage
 * for their venue+month, or a covered ledger that has no payout record at all.
 * Approximation: coverage is by venue+month ledger, not per-payment settlement.
 */
export function detectMissingSettlement(
  payments: FinancePayment[],
  ledgers: LedgerRowLite[],
  payouts: PayoutRowLite[],
  opts: { now?: Date; olderThanDays?: number } = {},
): ReassuranceException[] {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.olderThanDays ?? MISSING_SETTLEMENT_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const ledgerByKey = new Map(ledgers.map((l) => [`${l.venueId}|${monthKey(l.period)}`, l]));
  const payoutLedgerIds = new Set(payouts.map((p) => p.ledgerId));

  // Aggregate uncovered captures per venue+month so we don't emit one row per payment.
  const uncovered = new Map<string, { venueId: string; venueName: string; month: string; count: number; centsTotal: number }>();
  const noPayout = new Map<string, { ledgerId: string; venueId: string; venueName: string; period: string; count: number; centsTotal: number }>();

  for (const p of payments) {
    if (p.amountCapturedCents <= 0 || !p.capturedAt) continue;
    const t = Date.parse(p.capturedAt);
    if (!Number.isFinite(t) || t >= cutoff) continue;
    const venueId = p.venue?.id;
    const venueName = p.venue?.name ?? "Unknown venue";
    const month = monthKey(p.capturedAt);
    if (!venueId) {
      uncovered.set(`none|${p.id}`, { venueId: "", venueName: "Unattributed", month, count: 1, centsTotal: p.amountCapturedCents });
      continue;
    }
    const ledger = ledgerByKey.get(`${venueId}|${month}`);
    if (!ledger) {
      const key = `${venueId}|${month}`;
      const cur = uncovered.get(key) ?? { venueId, venueName, month, count: 0, centsTotal: 0 };
      cur.count += 1; cur.centsTotal += p.amountCapturedCents;
      uncovered.set(key, cur);
    } else if (!payoutLedgerIds.has(ledger.id)) {
      const key = ledger.id;
      const cur = noPayout.get(key) ?? { ledgerId: ledger.id, venueId, venueName, period: ledger.period, count: 0, centsTotal: 0 };
      cur.count += 1; cur.centsTotal += p.amountCapturedCents;
      noPayout.set(key, cur);
    }
  }

  const out: ReassuranceException[] = [];
  for (const u of uncovered.values()) {
    out.push({
      kind: "missing_settlement", severity: u.venueId ? "warning" : "info", entityType: "commission_period",
      entityId: `${u.venueId}|${u.month}`,
      label: `${u.venueName} · ${u.month}`,
      detail: u.venueId
        ? `${u.count} captured payment${u.count === 1 ? "" : "s"} (${cents(u.centsTotal)}) older than ${opts.olderThanDays ?? MISSING_SETTLEMENT_AGE_DAYS}d have no commission ledger for this venue+month — ledger may not have been generated.`
        : `${u.count} captured payment${u.count === 1 ? "" : "s"} (${cents(u.centsTotal)}) can't be attributed to a venue, so settlement coverage can't be verified.`,
      href: HREF_PAYOUTS,
    });
  }
  for (const n of noPayout.values()) {
    out.push({
      kind: "missing_settlement", severity: "info", entityType: "commission_ledger", entityId: n.ledgerId,
      label: `${n.venueName} · ${n.period.slice(0, 7)}`,
      detail: `Ledger covers ${n.count} captured payment${n.count === 1 ? "" : "s"} (${cents(n.centsTotal)}) but has no payout record — accrued commission may be awaiting scheduling.`,
      href: HREF_PAYOUTS,
    });
  }
  return out;
}

/** Refunds exceeding their payment's captured amount, or refunds with no captured payment behind them. */
export function detectUnexpectedRefund(refunds: RefundRowLite[], payments: FinancePayment[]): ReassuranceException[] {
  const payById = new Map(payments.map((p) => [p.id, p]));
  const byPayment = new Map<string, { captured: number; refunded: number; ids: string[] }>();
  const out: ReassuranceException[] = [];

  for (const r of refunds) {
    const pay = r.paymentId ? payById.get(r.paymentId) : undefined;
    if (!r.paymentId || !pay || pay.amountCapturedCents <= 0) {
      out.push({
        kind: "unexpected_refund", severity: "warning", entityType: "refund", entityId: r.id,
        label: `Refund ${r.id.slice(0, 8)}`,
        detail: `Refund of ${cents(r.amountCents)} has no matching captured payment${r.paymentId ? ` (payment ${r.paymentId.slice(0, 8)})` : ""} — possible orphaned refund.`,
        href: HREF_INVESTIGATIONS,
      });
      continue;
    }
    const cur = byPayment.get(r.paymentId) ?? { captured: pay.amountCapturedCents, refunded: 0, ids: [] };
    cur.refunded += r.amountCents; cur.ids.push(r.id);
    byPayment.set(r.paymentId, cur);
  }

  for (const [paymentId, agg] of byPayment) {
    if (agg.refunded > agg.captured) {
      out.push({
        kind: "unexpected_refund", severity: "critical", entityType: "payment", entityId: paymentId,
        label: `Payment ${paymentId.slice(0, 8)}`,
        detail: `Refunds total ${cents(agg.refunded)} against ${cents(agg.captured)} captured — over-refunded by ${cents(agg.refunded - agg.captured)} across ${agg.ids.length} refund${agg.ids.length === 1 ? "" : "s"}.`,
        href: HREF_INVESTIGATIONS,
      });
    }
  }
  return out;
}

const monthStart = (period: string) => Date.parse(`${period.slice(0, 7)}-01T00:00:00Z`);
const nextMonth = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/**
 * SAMPLED check: recomputes commission for each ledger from captured payments in
 * its venue+month using the venue's agreed rate. Ledgers without a rate are
 * skipped (counted), not flagged — no rate means nothing to verify against.
 */
export function detectCommissionMismatch(
  ledgers: LedgerRowLite[],
  payments: FinancePayment[],
  venuePcts: VenuePctMap,
): { exceptions: ReassuranceException[]; checked: number; skippedNoRate: number } {
  const exceptions: ReassuranceException[] = [];
  let checked = 0, skippedNoRate = 0;
  for (const l of ledgers) {
    const pct = venuePcts.get(l.venueId);
    if (pct == null) { skippedNoRate += 1; continue; }
    checked += 1;
    const start = monthStart(l.period), end = nextMonth(start);
    const pays = payments.filter((p) =>
      p.venue?.id === l.venueId && p.amountCapturedCents > 0 && p.capturedAt != null &&
      Date.parse(p.capturedAt) >= start && Date.parse(p.capturedAt) < end);
    const recomputed = computeLedger(
      pays.map((p) => ({ captured: p.amountCapturedCents, refunded: p.amountRefundedCents })), pct,
    );
    if (recomputed.commissionCents !== l.commissionCents) {
      exceptions.push({
        kind: "commission_mismatch", severity: "warning", entityType: "commission_ledger", entityId: l.id,
        label: `Ledger ${l.period.slice(0, 7)} · venue ${l.venueId.slice(0, 8)}`,
        detail: `Recorded commission ${cents(l.commissionCents)} vs recomputed ${cents(recomputed.commissionCents)} from ${pays.length} captured payment${pays.length === 1 ? "" : "s"} (sampled check — verify before adjusting).`,
        href: HREF_PAYOUTS,
      });
    }
  }
  return { exceptions, checked, skippedNoRate };
}

/** Payouts marked paid with no external provider reference — breaks the audit trail. */
export function detectMissingPayoutReference(payouts: PayoutRowLite[]): ReassuranceException[] {
  const out: ReassuranceException[] = [];
  for (const p of payouts) {
    if (p.status !== "paid") continue;
    if (p.providerReference != null && p.providerReference.trim() !== "") continue;
    out.push({
      kind: "missing_payout_reference", severity: "warning", entityType: "payout", entityId: p.id,
      label: `Payout ${p.id.slice(0, 8)}`,
      detail: `Payout of ${cents(p.amountCents)} is marked paid but has no provider reference — record the external transfer reference.`,
      href: HREF_PAYOUTS,
    });
  }
  return out;
}

// ─── Pure aggregation ─────────────────────────────────────────────────────────

export type AssuranceComputationInput = {
  payments: FinancePayment[];          // all captured history (< window.end)
  refunds: RefundRowLite[] | null;     // window-scoped; null = source unavailable
  disputes: DisputeRowLite[] | null;   // window-scoped; null = unavailable
  ledgers: LedgerRowLite[] | null;     // all ledgers; null = unavailable
  payouts: PayoutRowLite[] | null;     // all payouts; null = unavailable
  venuePcts: VenuePctMap;
  window: { start: string; end: string };
  now?: Date;
  olderThanDays?: number;
};

const inWindow = (iso: string | null, w: { start: string; end: string }) =>
  iso != null && iso >= w.start && iso < w.end;

const ledgerOverlaps = (period: string, w: { start: string; end: string }) => {
  const s = monthStart(period), e = nextMonth(s);
  return Date.parse(w.start) < e && s < Date.parse(w.end);
};

const disputeBucket = (status: string | null): "open" | "won" | "lost" => {
  const s = (status ?? "").toLowerCase();
  if (s === "won") return "won";
  if (s === "lost") return "lost";
  return "open"; // needs_response / under_review / warning_* / unknown — treated as open risk
};

function toCheck(kind: AssuranceCheckKind, label: string, run: () => ReassuranceException[] | { exceptions: ReassuranceException[] }): AssuranceCheck {
  try {
    const res = run();
    const list = Array.isArray(res) ? res : res.exceptions;
    const { total, items } = capExceptions(list);
    return { kind, label, status: "ok", total, items };
  } catch (e) {
    return { kind, label, status: "unavailable", reason: e instanceof Error ? e.message : "check failed", total: 0, items: [] };
  }
}

const unavailableCheck = (kind: AssuranceCheckKind, label: string, reason: string): AssuranceCheck =>
  ({ kind, label, status: "unavailable", reason, total: 0, items: [] });

export function computeAssurance(input: AssuranceComputationInput): { metrics: AssuranceMetrics; checks: AssuranceCheck[] } {
  const { window: w, payments } = input;
  const captured = payments.filter((p) => inWindow(p.capturedAt, w));

  // ── Metrics ──
  // Payments query succeeded by contract — zero captured is a real zero, not missing data.
  const grossCapturedCents = captured.reduce((a, p) => a + p.amountCapturedCents, 0);
  const estimatedStripeFeesCents = grossCapturedCents == null ? null : captured.reduce((a, p) => a + stripeFeeEstimateCents(p.amountCapturedCents), 0);

  let totalRefundedCents: number | null = null;
  let chargebackCount: number | null = null, chargebackCents: number | null = null;
  let openCount: number | null = null, openCents: number | null = null;
  let lostCount: number | null = null, lostCents: number | null = null;
  let wonCount: number | null = null;

  if (input.refunds != null) totalRefundedCents = input.refunds.reduce((a, r) => a + r.amountCents, 0);
  if (input.disputes != null) {
    let oc = 0, ocC = 0, lc = 0, lcC = 0, wc = 0;
    for (const d of input.disputes) {
      const b = disputeBucket(d.status);
      if (b === "open") { oc += 1; ocC += d.amountCents; }
      else if (b === "lost") { lc += 1; lcC += d.amountCents; }
      else wc += 1;
    }
    openCount = oc; openCents = ocC; lostCount = lc; lostCents = lcC; wonCount = wc;
    chargebackCount = oc + lc; chargebackCents = ocC + lcC;
  }

  const netProceedsCents =
    grossCapturedCents == null || totalRefundedCents == null || estimatedStripeFeesCents == null || lostCents == null
      ? null
      : grossCapturedCents - totalRefundedCents - estimatedStripeFeesCents - lostCents;

  let commissionAccruedCents: number | null = null, commissionPaidCents: number | null = null;
  let commissionOutstandingCents: number | null = null, payoutScheduledCount: number | null = null;
  if (input.ledgers != null && input.payouts != null) {
    const overlapping = input.ledgers.filter((l) => ledgerOverlaps(l.period, w));
    const ledgerIds = new Set(overlapping.map((l) => l.id));
    const paidByLedger = new Map<string, number>();
    let scheduled = 0;
    for (const p of input.payouts) {
      if (!ledgerIds.has(p.ledgerId)) continue;
      if (p.status === "paid") paidByLedger.set(p.ledgerId, (paidByLedger.get(p.ledgerId) ?? 0) + p.amountCents);
      if (p.status === "scheduled" || p.status === "approved") scheduled += 1;
    }
    commissionAccruedCents = overlapping.reduce((a, l) => a + l.commissionCents, 0);
    commissionPaidCents = overlapping.reduce((a, l) => a + (paidByLedger.get(l.id) ?? 0), 0);
    commissionOutstandingCents = overlapping.reduce((a, l) => a + Math.max(0, l.commissionCents - (paidByLedger.get(l.id) ?? 0)), 0);
    payoutScheduledCount = scheduled;
  }

  const metrics: AssuranceMetrics = {
    grossCapturedCents, totalRefundedCents, chargebackCount, chargebackCents,
    chargebacksOpenCount: openCount, chargebacksOpenCents: openCents,
    chargebacksLostCount: lostCount, chargebacksLostCents: lostCents,
    chargebacksWonCount: wonCount,
    estimatedStripeFeesCents, netProceedsCents,
    commissionAccruedCents, commissionPaidCents, commissionOutstandingCents, payoutScheduledCount,
  };

  // ── Checks ──
  const checks: AssuranceCheck[] = [
    toCheck("captured_without_entitlement", "Captured payments without an entitled rental", () =>
      detectCapturedWithoutEntitlement(payments)),
    toCheck("duplicate_captures", "Duplicate captures per rental", () =>
      detectDuplicateCaptures(payments)),
    input.refunds == null
      ? unavailableCheck("unexpected_refund", "Unexpected refunds", "refunds query failed")
      : toCheck("unexpected_refund", "Unexpected refunds", () => detectUnexpectedRefund(input.refunds as RefundRowLite[], payments)),
    input.ledgers == null || input.payouts == null
      ? unavailableCheck("missing_settlement", "Missing settlement coverage", "ledgers or payouts query failed")
      : toCheck("missing_settlement", "Missing settlement coverage", () =>
          detectMissingSettlement(payments, input.ledgers as LedgerRowLite[], input.payouts as PayoutRowLite[],
            { now: input.now, olderThanDays: input.olderThanDays })),
    input.ledgers == null
      ? unavailableCheck("commission_mismatch", "Commission ledger mismatches (sampled)", "ledgers query failed")
      : toCheck("commission_mismatch", "Commission ledger mismatches (sampled)", () =>
          detectCommissionMismatch(input.ledgers as LedgerRowLite[], payments, input.venuePcts)),
    input.payouts == null
      ? unavailableCheck("missing_payout_reference", "Paid payouts missing provider reference", "payouts query failed")
      : toCheck("missing_payout_reference", "Paid payouts missing provider reference", () =>
          detectMissingPayoutReference(input.payouts as PayoutRowLite[])),
  ];

  return { metrics, checks };
}

// ─── Supabase loader ──────────────────────────────────────────────────────────

const PAYMENT_SELECT =
  "id,rental_id,state,amount_captured_cents,amount_refunded_cents,captured_at," +
  "rentals!inner(id,state,kiosks!inner(id,venues(id,name,organization_id)))";

export type AssuranceWindow = ReturnType<typeof periodWindow>;

export async function loadRevenueAssurance(db: SupabaseClient, window: AssuranceWindow): Promise<RevenueAssurance> {
  const { start, end } = window;

  const [paysRes, refundsRes, disputesRes, ledgersRes, payoutsRes, agreementsRes, venuesRes] = await Promise.all([
    // All history up to window end — settlement checks need captures older than the window.
    db.from("payments").select(PAYMENT_SELECT).lt("captured_at", end).limit(50000),
    db.from("refunds").select("id,payment_id,amount_cents,created_at").gte("created_at", start).lt("created_at", end).limit(50000),
    db.from("disputes").select("id,payment_id,stripe_dispute_id,status,amount_cents,opened_at").gte("opened_at", start).lt("opened_at", end).limit(50000),
    db.from("commission_ledgers").select("id,venue_id,period,gross_cents,commission_cents").limit(10000),
    db.from("payout_records").select("id,ledger_id,amount_cents,status,provider_reference,created_at,paid_at").limit(10000),
    db.from("partner_agreements").select("venue_id,organization_id,terms").limit(5000),
    db.from("venues").select("id,organization_id").limit(5000),
  ]);

  // Payments are the spine of every figure — fail loudly rather than render $0.
  if (paysRes.error) throw new Error(`payments query failed: ${paysRes.error.message}`);

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sourceErrors: Record<string, string> = {};
  const failed = (key: string, err: { message: string } | null) => { if (err) sourceErrors[key] = err.message; };

  failed("refunds", refundsRes.error); failed("disputes", disputesRes.error);
  failed("ledgers", ledgersRes.error); failed("payouts", payoutsRes.error);

  const payments = ((paysRes.data ?? []) as unknown as Parameters<typeof normalizePayment>[0][]).map(normalizePayment);

  const refunds: RefundRowLite[] | null = refundsRes.error ? null : ((refundsRes.data ?? []) as { id: string; payment_id: string | null; amount_cents: number | null }[])
    .map((r) => ({ id: r.id, paymentId: r.payment_id, amountCents: num(r.amount_cents) }));

  const disputes: DisputeRowLite[] | null = disputesRes.error ? null : ((disputesRes.data ?? []) as { id: string; payment_id: string | null; stripe_dispute_id: string | null; status: string | null; amount_cents: number | null; opened_at: string | null }[])
    .map((d) => ({ id: d.id, paymentId: d.payment_id, stripeDisputeId: d.stripe_dispute_id, status: d.status, amountCents: num(d.amount_cents), openedAt: d.opened_at }));

  const ledgers: LedgerRowLite[] | null = ledgersRes.error ? null : ((ledgersRes.data ?? []) as { id: string; venue_id: string; period: string; gross_cents: number | null; commission_cents: number | null }[])
    .map((l) => ({ id: l.id, venueId: l.venue_id, period: typeof l.period === "string" ? l.period : String(l.period), grossCents: num(l.gross_cents), commissionCents: num(l.commission_cents) }));

  const payouts: PayoutRowLite[] | null = payoutsRes.error ? null : ((payoutsRes.data ?? []) as { id: string; ledger_id: string; amount_cents: number | null; status: string | null; provider_reference: string | null }[])
    .map((p) => ({ id: p.id, ledgerId: p.ledger_id, amountCents: num(p.amount_cents), status: p.status ?? "", providerReference: p.provider_reference }));

  const pcts = venuePctMap(
    (agreementsRes.data ?? []) as { venue_id: string | null; organization_id: string | null; terms: unknown }[],
    (venuesRes.data ?? []) as { id: string; organization_id: string | null }[],
  );

  const { metrics, checks } = computeAssurance({
    payments, refunds, disputes, ledgers, payouts, venuePcts: pcts,
    window: { start, end }, now: new Date(end),
  });

  // Surface source failures inside the checks that depend on them.
  for (const c of checks) {
    if (c.status !== "ok") continue;
    const dep: Partial<Record<AssuranceCheckKind, string>> = {
      unexpected_refund: "refunds", missing_settlement: "ledgers",
      commission_mismatch: "ledgers", missing_payout_reference: "payouts",
    };
    const key = dep[c.kind];
    if (key && sourceErrors[key]) {
      c.status = "unavailable"; c.reason = `source query failed: ${sourceErrors[key]}`; c.total = 0; c.items = [];
    }
    if (c.kind === "missing_settlement" && sourceErrors.payouts) {
      c.status = "unavailable"; c.reason = `source query failed: ${sourceErrors.payouts}`; c.total = 0; c.items = [];
    }
  }

  return { window, metrics, checks };
}
