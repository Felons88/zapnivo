import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ad delivery eligibility — the single source of truth for "may this creative be
 * shown on this kiosk right now". Used by the kiosk manifest endpoint, the
 * creative proxy, and playback event ingest. Conservative by design: anything
 * ambiguous is NOT deliverable.
 */

type CampaignRow = {
  id: string;
  status: string;
  payment_status: string;
  targeting: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  starts_at: string | null;
  ends_at: string | null;
};

type KioskRow = { id: string; venue_id: string | null };

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

const inWindow = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
};
const beforeEnd = (iso: string | null | undefined, now: Date): boolean => {
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= now.getTime();
};

/** Campaign must be paid and inside its delivery window (schedule jsonb wins over legacy columns). */
export function isCampaignDeliverable(c: CampaignRow, now = new Date()): boolean {
  if (c.status !== "scheduled" && c.status !== "live") return false;
  if (c.payment_status !== "paid") return false;
  const sched = c.schedule ?? {};
  const start = (sched.starts_at as string | undefined) ?? c.starts_at;
  const end = (sched.ends_at as string | undefined) ?? c.ends_at;
  return inWindow(start, now) && beforeEnd(end, now);
}

/**
 * Targeting match. Empty targeting = network-wide. Otherwise the kiosk must match
 * at least one populated criterion: station_ids (kiosk ids), venue_ids, cities,
 * venue_types. Kiosk city/type are resolved by the caller via venue join.
 */
export async function campaignTargetsKiosk(
  db: SupabaseClient,
  campaign: CampaignRow,
  kiosk: KioskRow,
  venue: { id: string; city: string | null; venue_type: string | null } | null,
): Promise<boolean> {
  const t = campaign.targeting ?? {};
  const stationIds = asArray(t.station_ids);
  const venueIds = asArray(t.venue_ids);
  const cities = asArray(t.cities).map((c) => c.toLowerCase());
  const types = asArray(t.venue_types).map((v) => v.toLowerCase());

  const anyTargeting = stationIds.length + venueIds.length + cities.length + types.length > 0;
  if (!anyTargeting) return true;

  if (stationIds.includes(kiosk.id)) return true;
  if (venue && venueIds.includes(venue.id)) return true;
  if (venue?.city && cities.includes(venue.city.toLowerCase())) return true;
  if (venue?.venue_type && types.includes(venue.venue_type.toLowerCase())) return true;
  return false;
}

/** Full check: deliverable + targets this kiosk. */
export async function isCampaignEligibleForKiosk(
  db: SupabaseClient,
  campaign: CampaignRow,
  kiosk: KioskRow & { venue?: { id: string; city: string | null; venue_type: string | null } | null },
  now = new Date(),
): Promise<boolean> {
  if (!isCampaignDeliverable(campaign, now)) return false;
  return campaignTargetsKiosk(db, campaign, kiosk, kiosk.venue ?? null);
}
