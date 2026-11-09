import type { SupabaseClient } from "@supabase/supabase-js";

/** Commission is a private agreement term: terms.commission_pct, a number 0–100. No default, ever. */
export function parseCommissionPct(terms: unknown): number | null {
  const v = terms && typeof terms === "object" ? (terms as Record<string, unknown>).commission_pct : null;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

export type PaymentLine = { captured: number | null; refunded: number | null };

/** Net gross = captured minus refunded (never negative); commission rounded to the cent. */
export function computeLedger(payments: PaymentLine[], pct: number) {
  const gross = payments.reduce((a, p) => a + Math.max(0, (p.captured ?? 0) - (p.refunded ?? 0)), 0);
  return { grossCents: gross, commissionCents: Math.round((gross * pct) / 100) };
}

export const periodBounds = (period: string) => {
  const start = new Date(`${period}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString(), date: `${period}-01` };
};

export const previousPeriod = (now = new Date()) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

type PayRow = { amount_captured_cents: number | null; amount_refunded_cents: number | null };

/**
 * Generates (upserts) one commission ledger per venue for a YYYY-MM period.
 * Skips venues without a private commission rate, and never rewrites a ledger that already has payouts.
 */
export async function generateLedgers(db: SupabaseClient, period: string) {
  const { start, end, date } = periodBounds(period);
  const [{ data: venues }, { data: agreements }] = await Promise.all([
    db.from("venues").select("id,name,organization_id").limit(2000),
    db.from("partner_agreements").select("organization_id,venue_id,terms,signed_at").order("signed_at", { ascending: false, nullsFirst: false }).limit(2000),
  ]);
  const created: string[] = [], skippedNoRate: string[] = [], skippedLocked: string[] = [];

  for (const v of (venues ?? []) as { id: string; name: string; organization_id: string | null }[]) {
    const ag = ((agreements ?? []) as { organization_id: string; venue_id: string | null; terms: unknown }[])
      .find((a) => a.venue_id === v.id) ?? ((agreements ?? []) as { organization_id: string; venue_id: string | null; terms: unknown }[]).find((a) => a.organization_id === v.organization_id && !a.venue_id);
    const pct = ag ? parseCommissionPct(ag.terms) : null;
    if (pct == null) { skippedNoRate.push(v.name); continue; }

    const { data: pays } = await db.from("payments")
      .select("amount_captured_cents,amount_refunded_cents,rentals!inner(kiosk_id,kiosks!inner(venue_id))")
      .eq("rentals.kiosks.venue_id", v.id).gte("captured_at", start).lt("captured_at", end).limit(20000);
    const { grossCents, commissionCents } = computeLedger(((pays ?? []) as PayRow[]).map((p) => ({ captured: p.amount_captured_cents, refunded: p.amount_refunded_cents })), pct);

    const { data: existing } = await db.from("commission_ledgers").select("id").eq("venue_id", v.id).eq("period", date).maybeSingle();
    if (existing) {
      const { count } = await db.from("payout_records").select("id", { count: "exact", head: true }).eq("ledger_id", existing.id);
      if ((count ?? 0) > 0) { skippedLocked.push(v.name); continue; }
    }
    await db.from("commission_ledgers").upsert({ venue_id: v.id, period: date, gross_cents: grossCents, commission_cents: commissionCents }, { onConflict: "venue_id,period" });
    created.push(v.name);
  }
  return { created, skippedNoRate, skippedLocked };
}
