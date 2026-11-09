import type { SupabaseClient } from "@supabase/supabase-js";
import { getPaymentSource, type PaymentSource } from "./payments/source";
import { rateLimit } from "./rate-limit";
import { describeRental, type RentalResult, type RentalRow } from "./rental-lookup";
import { serviceClient } from "./supabase";
import type { z } from "zod";
import type { rentalLookupSchema } from "./validation";

export type RentalQuery = z.infer<typeof rentalLookupSchema>;

export type LookupOutcome =
  | { status: "ok"; results: RentalResult[] }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfter: number }
  | { status: "unconfigured" }
  | { status: "error" };

type Deps = { db?: SupabaseClient | null; payments?: PaymentSource };

/**
 * The ONE place rentals are looked up. Used by the lookup form API and the AI assistant, so both
 * share identical security: exact receipt-email match, per-IP + per-email rate limits, a
 * customer-safe projection, and live Stripe truth when a PaymentSource is linked.
 */
export async function lookupRentals(q: RentalQuery, ip: string, deps: Deps = {}): Promise<LookupOutcome> {
  const a = rateLimit(`lookup-ip:${ip}`, 12, 15 * 60_000);
  const b = rateLimit(`lookup-email:${q.email}`, 6, 15 * 60_000);
  if (!a.ok || !b.ok) return { status: "rate_limited", retryAfter: Math.max(a.retryAfter, b.retryAfter) };

  const db = deps.db === undefined ? serviceClient() : deps.db;
  if (!db) return { status: "unconfigured" };

  let query = db
    .from("rentals")
    .select("reference,state,started_at,dispensed_at,returned_at,non_return_deadline,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments!inner(state,amount_captured_cents,amount_refunded_cents,stripe_payment_intent_id,receipt_email)")
    .eq("payments.receipt_email", q.email)
    .order("created_at", { ascending: false })
    .limit(10);
  query = q.reference ? query.eq("reference", q.reference) : query.gte("started_at", q.from!).lte("started_at", q.to!);

  const { data, error } = await query;
  if (error) {
    console.error(JSON.stringify({ level: "error", scope: "rental-lookup", msg: "query_failed", code: error.code }));
    return { status: "error" };
  }

  let rows = (data ?? []) as unknown as RentalRow[];
  if (q.station) {
    const s = q.station.toLowerCase();
    rows = rows.filter((r) => `${r.kiosks?.station_id ?? ""} ${r.kiosks?.venues?.name ?? ""} ${r.kiosks?.venues?.city ?? ""}`.toLowerCase().includes(s));
  }
  if (!rows.length) return { status: "not_found" };

  rows = await withLivePayments(rows, deps.payments ?? getPaymentSource());
  return { status: "ok", results: rows.map(describeRental) };
}

/** Overlay live payment data (Stripe) on database rows. A failure for one payment keeps the DB value. */
async function withLivePayments(rows: RentalRow[], source: PaymentSource): Promise<RentalRow[]> {
  return Promise.all(rows.map(async (r) => ({
    ...r,
    payments: await Promise.all(r.payments.map(async (p) => {
      if (!p.stripe_payment_intent_id) return p;
      try {
        const live = await source.summarize(p.stripe_payment_intent_id);
        return live ? { ...p, amount_captured_cents: live.capturedCents, amount_refunded_cents: live.refundedCents } : p;
      } catch { return p; }
    })),
  })));
}

export const NOT_FOUND_MESSAGE = "We couldn't find a rental matching those details. Check the email used at checkout and try a wider date range, or open a ticket and we'll look manually.";
