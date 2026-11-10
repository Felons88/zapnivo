import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCommissionPct } from "./ledgers";

/**
 * Finance reporting — read-only aggregation over payments / refunds / sms_messages /
 * payout_records / partner_agreements. Every figure traces to a real row; nothing is
 * estimated except Stripe processing fees (clearly labelled) and SMS cost (only when an
 * admin-configured per-message rate exists in system_config — otherwise "not tracked").
 *
 * Revenue rule: only payments with a captured amount count. Authorizations, holds and
 * released payments never appear as revenue.
 */

export const STRIPE_FEE_PERCENT = 0.029; // estimate: 2.9% — labelled as an estimate everywhere it surfaces
export const STRIPE_FEE_FIXED_CENTS = 30; // estimate: +$0.30 per captured payment
export const SMS_COST_CONFIG_KEY = "sms_outbound_cost_cents";

/** Rental states where the captured hold is the non-return fee rather than rental time. */
export const NON_RETURN_RENTAL_STATES = new Set(["charged_off", "non_return_fee_paid", "non_return_fee_pending"]);

export const PERIOD_DAYS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIOD_DAYS)[number];

export const parsePeriodDays = (v: string | null | undefined): PeriodDays => {
  const n = Number(v);
  return (PERIOD_DAYS as readonly number[]).includes(n) ? (n as PeriodDays) : 30;
};

/** Rolling window ending now — [start, end). */
export function periodWindow(days: PeriodDays, now = new Date()) {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { days, start: start.toISOString(), end: now.toISOString() };
}

// ─── Row shapes (PostgREST nested embeds arrive as object | array | null) ─────

export type VenueRef = { id: string; name: string; organization_id: string | null };

export type FinancePayment = {
  id: string;
  rentalId: string | null;
  state: string | null;
  amountCapturedCents: number;
  amountRefundedCents: number;
  capturedAt: string | null;
  rentalState: string | null;
  venue: VenueRef | null;
};

export type FinanceRefund = { id: string; amountCents: number; paymentId: string | null; venue: VenueRef | null };

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const PAYMENT_SELECT =
  "id,rental_id,state,amount_captured_cents,amount_refunded_cents,captured_at," +
  "rentals!inner(id,state,kiosks!inner(id,venues(id,name,organization_id)))";
const VENUE_SELECT = "id,rental_id,rentals!inner(kiosks!inner(venues(id,name,organization_id)))";

type RawPayment = {
  id: string; rental_id: string | null; state: string | null;
  amount_captured_cents: number | null; amount_refunded_cents: number | null; captured_at: string | null;
  rentals?: { id?: string; state?: string | null; kiosks?: { venues?: VenueRef | VenueRef[] | null } | { venues?: VenueRef | VenueRef[] | null }[] | null } | { id?: string; state?: string | null; kiosks?: { venues?: VenueRef | VenueRef[] | null } | { venues?: VenueRef | VenueRef[] | null }[] | null }[] | null;
};

function venueOf(raw: RawPayment["rentals"]): VenueRef | null {
  const r = one(raw as never);
  const kiosk = one((r as { kiosks?: unknown } | null)?.kiosks as never);
  const v = one((kiosk as { venues?: VenueRef | VenueRef[] | null } | null)?.venues);
  return v && typeof v.id === "string" ? { id: v.id, name: v.name, organization_id: v.organization_id ?? null } : null;
}

export function normalizePayment(row: RawPayment): FinancePayment {
  const r = one(row.rentals as never) as { id?: string; state?: string | null } | null;
  return {
    id: row.id,
    rentalId: row.rental_id ?? r?.id ?? null,
    state: row.state ?? null,
    amountCapturedCents: num(row.amount_captured_cents),
    amountRefundedCents: num(row.amount_refunded_cents),
    capturedAt: row.captured_at ?? null,
    rentalState: r?.state ?? null,
    venue: venueOf(row.rentals),
  };
}

export function normalizeVenuePayment(row: { id: string; rental_id?: string | null; rentals?: unknown }): { id: string; rentalId: string | null; venue: VenueRef | null } {
  const r = one((row as RawPayment).rentals as never);
  return { id: row.id, rentalId: row.rental_id ?? null, venue: venueOf((row as RawPayment).rentals) };
}

// ─── Pure aggregation ─────────────────────────────────────────────────────────

/** Stripe's cut on ONE captured payment intent — an estimate (2.9% + $0.30), not actuals. */
export const stripeFeeEstimateCents = (capturedCents: number) =>
  capturedCents > 0 ? Math.round(capturedCents * STRIPE_FEE_PERCENT) + STRIPE_FEE_FIXED_CENTS : 0;

export const isNonReturnPayment = (p: Pick<FinancePayment, "rentalState">) =>
  p.rentalState != null && NON_RETURN_RENTAL_STATES.has(p.rentalState);

export type PaymentTotals = {
  grossCapturedCents: number;
  netCapturedCents: number; // captured minus refunded, never below zero per payment
  paymentCount: number;
  rentalRevenueCents: number;
  rentalPaymentCount: number;
  nonReturnFeeCents: number;
  nonReturnFeePaymentCount: number;
  stripeFeesCents: number; // estimate over all captured payments
};

/** Only rows with a real captured amount count — authorizations are excluded by amount, not by state string. */
export function summarizePayments(payments: FinancePayment[]): PaymentTotals {
  const t: PaymentTotals = {
    grossCapturedCents: 0, netCapturedCents: 0, paymentCount: 0,
    rentalRevenueCents: 0, rentalPaymentCount: 0,
    nonReturnFeeCents: 0, nonReturnFeePaymentCount: 0, stripeFeesCents: 0,
  };
  for (const p of payments) {
    if (p.amountCapturedCents <= 0) continue; // authorized / released / failed — never revenue
    t.paymentCount += 1;
    t.grossCapturedCents += p.amountCapturedCents;
    t.netCapturedCents += Math.max(0, p.amountCapturedCents - p.amountRefundedCents);
    t.stripeFeesCents += stripeFeeEstimateCents(p.amountCapturedCents);
    if (isNonReturnPayment(p)) { t.nonReturnFeeCents += p.amountCapturedCents; t.nonReturnFeePaymentCount += 1; }
    else { t.rentalRevenueCents += p.amountCapturedCents; t.rentalPaymentCount += 1; }
  }
  return t;
}

export function summarizePayouts(rows: { amount_cents: number | null; status: string | null }[]) {
  const out = { scheduledCents: 0, paidCents: 0, scheduledCount: 0, paidCount: 0 };
  for (const r of rows) {
    const cents = num(r.amount_cents);
    if (r.status === "scheduled") { out.scheduledCents += cents; out.scheduledCount += 1; }
    else if (r.status === "paid") { out.paidCents += cents; out.paidCount += 1; }
  }
  return out;
}

export type VenuePctMap = Map<string, number>; // venue_id → commission_pct (explicit agreements only)

export function venuePctMap(agreements: { venue_id: string | null; organization_id: string | null; terms: unknown }[], venues: { id: string; organization_id: string | null }[]): VenuePctMap {
  const map = new Map<string, number>();
  const byVenue = new Map(agreements.filter((a) => a.venue_id).map((a) => [a.venue_id as string, a]));
  const byOrg = new Map<string, (typeof agreements)[number]>();
  for (const a of agreements) if (!a.venue_id && a.organization_id && !byOrg.has(a.organization_id)) byOrg.set(a.organization_id, a);
  for (const v of venues) {
    const ag = byVenue.get(v.id) ?? (v.organization_id ? byOrg.get(v.organization_id) : undefined);
    const pct = ag ? parseCommissionPct(ag.terms) : null;
    if (pct != null) map.set(v.id, pct);
  }
  return map;
}

export type FinanceInput = {
  payments: FinancePayment[];
  refunds: FinanceRefund[];
  smsOutboundCount: number;
  smsCostPerMessageCents: number | null; // null = not tracked
  venuePcts: VenuePctMap;
  payouts: { scheduledCents: number; paidCents: number; scheduledCount: number; paidCount: number };
  actualStripeFeesCents: number | null; // from billing_ledger when present, else null → estimate
};

export type VenueRow = {
  venueId: string;
  venueName: string;
  rentalsCount: number; // distinct rentals with a captured payment
  capturedCents: number;
  refundedCents: number;
  netCents: number;
  stripeFeesCents: number; // estimate — actual fee data is platform-level only
  venueShareCents: number | null; // null when no explicit commission rate exists
};

export type FinanceSummary = {
  period: { days: PeriodDays; start: string; end: string };
  rentalRevenueCents: number;
  rentalPaymentCount: number;
  nonReturnFeeCents: number;
  nonReturnFeePaymentCount: number;
  refundsCents: number;
  refundCount: number;
  stripeFeesCents: number;
  stripeFeesEstimated: boolean;
  smsOutboundCount: number;
  smsCostCents: number | null;
  smsCostTracked: boolean;
  venueShareCents: number;
  venuesWithRate: number;
  grossCapturedCents: number;
  netPlatformCents: number;
  payouts: { scheduledCents: number; paidCents: number; scheduledCount: number; paidCount: number };
};

export function computeSummary(input: FinanceInput, window: { days: PeriodDays; start: string; end: string }): FinanceSummary {
  const p = summarizePayments(input.payments);
  const refundsCents = input.refunds.reduce((a, r) => a + r.amountCents, 0);
  const stripeFeesCents = input.actualStripeFeesCents ?? p.stripeFeesCents;
  const smsCostCents = input.smsCostPerMessageCents != null ? input.smsOutboundCount * input.smsCostPerMessageCents : null;

  // Venue revenue share: explicit commission_pct only, on each venue's net captured (floor 0).
  const netByVenue = new Map<string, number>();
  for (const pay of input.payments) {
    if (pay.amountCapturedCents <= 0 || !pay.venue) continue;
    netByVenue.set(pay.venue.id, (netByVenue.get(pay.venue.id) ?? 0) + Math.max(0, pay.amountCapturedCents - pay.amountRefundedCents));
  }
  let venueShareCents = 0, venuesWithRate = 0;
  for (const [venueId, pct] of input.venuePcts) {
    const net = netByVenue.get(venueId);
    if (net == null || net <= 0) continue;
    venuesWithRate += 1;
    venueShareCents += Math.round((net * pct) / 100);
  }

  const netPlatformCents =
    p.rentalRevenueCents + p.nonReturnFeeCents - refundsCents - stripeFeesCents - (smsCostCents ?? 0) - venueShareCents;

  return {
    period: window,
    rentalRevenueCents: p.rentalRevenueCents,
    rentalPaymentCount: p.rentalPaymentCount,
    nonReturnFeeCents: p.nonReturnFeeCents,
    nonReturnFeePaymentCount: p.nonReturnFeePaymentCount,
    refundsCents,
    refundCount: input.refunds.length,
    stripeFeesCents,
    stripeFeesEstimated: input.actualStripeFeesCents == null,
    smsOutboundCount: input.smsOutboundCount,
    smsCostCents,
    smsCostTracked: smsCostCents != null,
    venueShareCents,
    venuesWithRate,
    grossCapturedCents: p.grossCapturedCents,
    netPlatformCents,
    payouts: input.payouts,
  };
}

export function groupByVenue(input: Pick<FinanceInput, "payments" | "refunds" | "venuePcts">): VenueRow[] {
  const map = new Map<string, VenueRow & { rentals: Set<string> }>();
  const row = (v: VenueRef) => {
    let r = map.get(v.id);
    if (!r) { r = { venueId: v.id, venueName: v.name, rentals: new Set(), rentalsCount: 0, capturedCents: 0, refundedCents: 0, netCents: 0, stripeFeesCents: 0, venueShareCents: null }; map.set(v.id, r); }
    return r;
  };
  for (const p of input.payments) {
    if (p.amountCapturedCents <= 0 || !p.venue) continue;
    const r = row(p.venue);
    if (p.rentalId) r.rentals.add(p.rentalId);
    r.capturedCents += p.amountCapturedCents;
    r.refundedCents += Math.min(p.amountRefundedCents, p.amountCapturedCents);
    r.stripeFeesCents += stripeFeeEstimateCents(p.amountCapturedCents);
  }
  for (const ref of input.refunds) {
    if (ref.venue) row(ref.venue).refundedCents += ref.amountCents;
  }
  for (const r of map.values()) {
    r.rentalsCount = r.rentals.size;
    r.netCents = Math.max(0, r.capturedCents - r.refundedCents);
    const pct = input.venuePcts.get(r.venueId);
    r.venueShareCents = pct != null ? Math.round((r.netCents * pct) / 100) : null;
    delete (r as { rentals?: Set<string> }).rentals;
  }
  return [...map.values()].sort((a, b) => b.capturedCents - a.capturedCents || a.venueName.localeCompare(b.venueName));
}

// ─── Supabase fetchers ────────────────────────────────────────────────────────

export type FinanceData = {
  payments: FinancePayment[];
  refunds: FinanceRefund[];
  smsOutboundCount: number;
  smsCostPerMessageCents: number | null;
  venuePcts: VenuePctMap;
  payouts: ReturnType<typeof summarizePayouts>;
  actualStripeFeesCents: number | null;
};

/** Actual Stripe fees from billing_ledger if that table exists (added by a parallel migration); null otherwise. */
async function fetchActualStripeFees(db: SupabaseClient, start: string, end: string): Promise<number | null> {
  try {
    const { data, error } = await db.from("billing_ledger").select("*").gte("created_at", start).lt("created_at", end).limit(5000);
    if (error || !data?.length) return null;
    // Column names aren't fixed yet — accept the first numeric fee-ish column we find.
    const keys = Object.keys(data[0] as Record<string, unknown>).filter((k) => /fee/i.test(k) && /stripe|processing|card/i.test(k));
    const key = keys.find((k) => data.every((r) => typeof (r as Record<string, unknown>)[k] === "number" || (r as Record<string, unknown>)[k] == null));
    if (!key) return null;
    const sum = data.reduce((a, r) => a + num((r as Record<string, unknown>)[key]), 0);
    return sum > 0 ? sum : null;
  } catch {
    return null;
  }
}

export async function fetchFinanceData(db: SupabaseClient, window: { start: string; end: string }): Promise<FinanceData> {
  const { start, end } = window;

  const [paysRes, refundsRes, smsRes, cfgRes, agreementsRes, venuesRes, payoutsRes] = await Promise.all([
    // captured_at is only set on capture — authorizations never match this filter.
    db.from("payments").select(PAYMENT_SELECT).gte("captured_at", start).lt("captured_at", end).limit(50000),
    db.from("refunds").select("id,payment_id,amount_cents,created_at").gte("created_at", start).lt("created_at", end).limit(50000),
    db.from("sms_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("created_at", start).lt("created_at", end),
    db.from("system_config").select("value").eq("key", SMS_COST_CONFIG_KEY).maybeSingle(),
    db.from("partner_agreements").select("venue_id,organization_id,terms").limit(5000),
    db.from("venues").select("id,organization_id").limit(5000),
    db.from("payout_records").select("amount_cents,status").limit(10000),
  ]);

  // A failed payments read must not silently render as $0 — surface it honestly.
  if (paysRes.error) throw new Error(`payments query failed: ${paysRes.error.message}`);

  const payments = ((paysRes.data ?? []) as unknown as RawPayment[]).map(normalizePayment);

  // Refunds need a venue: resolve payment → rental → kiosk → venue in a second hop.
  const refundRows = (refundsRes.data ?? []) as { id: string; payment_id: string | null; amount_cents: number | null }[];
  const venueByPayment = new Map<string, VenueRef | null>();
  const payIds = [...new Set(refundRows.map((r) => r.payment_id).filter((x): x is string => !!x))];
  if (payIds.length) {
    for (let i = 0; i < payIds.length; i += 400) {
      const { data } = await db.from("payments").select(VENUE_SELECT).in("id", payIds.slice(i, i + 400)).limit(400);
      for (const row of (data ?? []) as unknown as RawPayment[]) venueByPayment.set(row.id, venueOf(row.rentals));
    }
  }
  const refunds: FinanceRefund[] = refundRows.map((r) => ({
    id: r.id, amountCents: num(r.amount_cents), paymentId: r.payment_id,
    venue: r.payment_id ? (venueByPayment.get(r.payment_id) ?? null) : null,
  }));

  const cfgVal = (cfgRes.data as { value?: string } | null)?.value;
  const rate = cfgVal != null && cfgVal !== "" && Number.isFinite(Number(cfgVal)) ? Math.max(0, Math.round(Number(cfgVal))) : null;

  return {
    payments,
    refunds,
    smsOutboundCount: smsRes.count ?? 0,
    smsCostPerMessageCents: rate,
    venuePcts: venuePctMap(
      (agreementsRes.data ?? []) as { venue_id: string | null; organization_id: string | null; terms: unknown }[],
      (venuesRes.data ?? []) as { id: string; organization_id: string | null }[],
    ),
    payouts: summarizePayouts((payoutsRes.data ?? []) as { amount_cents: number | null; status: string | null }[]),
    actualStripeFeesCents: await fetchActualStripeFees(db, start, end),
  };
}
