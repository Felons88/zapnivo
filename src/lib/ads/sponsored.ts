import type { SupabaseClient } from "@supabase/supabase-js";
import { rentalChargeCents as chargeForMinutes } from "@/lib/pricing";
import type { PricingVersion } from "@/lib/pricing";

/**
 * Sponsored charging — a sponsor funds the first N minutes of eligible rentals.
 * The customer's Stripe hold is unchanged; the sponsored portion is discounted at
 * capture time and the cost is attributed to the sponsor's budget. Eligibility is
 * enforced server-side at checkout AND re-checked at settlement.
 */

type SponsorRow = {
  id: string; name: string; sponsor_name: string; status: string;
  credit_minutes: number; per_customer_minutes: number; per_day_minutes: number | null; budget_cents: number | null;
  spent_cents: number; targeting: Record<string, unknown> | null;
  starts_at: string; ends_at: string;
};

const asArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/** Same targeting semantics as ad campaigns: empty = network-wide, else match any criterion. */
function sponsorTargets(s: SponsorRow, kioskId: string, venue: { id: string; city: string | null; venue_type: string | null } | null): boolean {
  const t = s.targeting ?? {};
  const stationIds = asArray(t.station_ids), venueIds = asArray(t.venue_ids);
  const cities = asArray(t.cities).map((c) => c.toLowerCase()), types = asArray(t.venue_types).map((v) => v.toLowerCase());
  if (!stationIds.length && !venueIds.length && !cities.length && !types.length) return true;
  if (stationIds.includes(kioskId)) return true;
  if (venue && venueIds.includes(venue.id)) return true;
  if (venue?.city && cities.includes(venue.city.toLowerCase())) return true;
  if (venue?.venue_type && types.includes(venue.venue_type.toLowerCase())) return true;
  return false;
}

/** Active sponsor campaigns for a kiosk right now, budget not exhausted. */
export async function activeSponsorsForKiosk(
  db: SupabaseClient,
  kioskId: string,
  venue: { id: string; city: string | null; venue_type: string | null } | null,
  now = new Date(),
): Promise<SponsorRow[]> {
  const { data } = await db.from("sponsor_campaigns")
    .select("id,name,sponsor_name,status,credit_minutes,per_customer_minutes,per_day_minutes,budget_cents,spent_cents,targeting,starts_at,ends_at")
    .eq("status", "active")
    .lte("starts_at", now.toISOString()).gte("ends_at", now.toISOString())
    .limit(20);
  return ((data ?? []) as SponsorRow[]).filter((s) =>
    sponsorTargets(s, kioskId, venue) && (s.budget_cents === null || s.spent_cents < s.budget_cents));
}

/**
 * Records the sponsorship on a freshly created rental. minutes_covered is the
 * per-customer cap — actual discount is computed from real elapsed time at
 * settlement, so a 5-minute rental never consumes the full allowance.
 * Returns the redemption id or null when no sponsor applies / insert fails.
 */
export async function applySponsorAtCheckout(
  db: SupabaseClient,
  args: { campaignId: string; rentalId: string; customerRef: string; kioskId: string; venue: { id: string; city: string | null; venue_type: string | null } | null },
): Promise<string | null> {
  const { data: camp } = await db.from("sponsor_campaigns")
    .select("id,status,credit_minutes,per_customer_minutes,per_day_minutes,budget_cents,spent_cents,targeting,starts_at,ends_at")
    .eq("id", args.campaignId).maybeSingle();
  const s = camp as SponsorRow | null;
  const now = new Date();
  if (!s || s.status !== "active" || !sponsorTargets(s, args.kioskId, args.venue)) return null;
  if (s.budget_cents !== null && s.spent_cents >= s.budget_cents) return null;
  if (Date.parse(s.starts_at) > now.getTime() || Date.parse(s.ends_at) < now.getTime()) return null;
  const minutes = Math.min(s.per_customer_minutes, s.credit_minutes);

  // Per-day cap: sum of minutes already redeemed by this customer today (UTC).
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const perDay = (s as { per_day_minutes?: number | null }).per_day_minutes;
  if (perDay) {
    const { data: todays } = await db.from("sponsored_redemptions")
      .select("minutes_covered").eq("campaign_id", s.id).eq("customer_ref", args.customerRef)
      .eq("status", "applied").gte("created_at", dayStart.toISOString());
    const used = ((todays ?? []) as { minutes_covered: number }[]).reduce((sum, r) => sum + r.minutes_covered, 0);
    if (used >= perDay) return null;
  }

  const { data, error } = await db.from("sponsored_redemptions")
    .insert({ campaign_id: s.id, rental_id: args.rentalId, customer_ref: args.customerRef, minutes_covered: minutes, status: "applied" })
    .select("id").single();
  if (error) return null; // unique(rental_id) or DB issue — rental proceeds unsponsored
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Discount (cents) the sponsor covers for this rental at settlement.
 * = charge attributable to covered minutes, capped by remaining net charge.
 */
export function sponsoredDiscountCents(args: {
  elapsedMinutes: number; minutesCovered: number; bankCount: number;
  pricing: PricingVersion; capCents: number;
}): number {
  const covered = Math.min(Math.max(0, args.elapsedMinutes), args.minutesCovered);
  if (covered <= 0 || args.capCents <= 0) return 0;
  const gross = (chargeForMinutes(covered, args.pricing) ?? 0) * args.bankCount;
  return Math.max(0, Math.min(gross, args.capCents));
}

/** Marks spend against the sponsor budget after a successful capture. Best-effort. */
export async function recordSponsorSpend(db: SupabaseClient, campaignId: string, cents: number): Promise<void> {
  if (cents <= 0) return;
  const { data } = await db.from("sponsor_campaigns").select("spent_cents").eq("id", campaignId).maybeSingle();
  const current = (data as { spent_cents?: number } | null)?.spent_cents ?? 0;
  await db.from("sponsor_campaigns").update({ spent_cents: current + cents }).eq("id", campaignId);
}
