import type { SupabaseClient } from "@supabase/supabase-js";
import { getSessionUser, type SessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

/**
 * Advertiser self-serve marketplace helpers. Server-only: every function that
 * touches the DB takes the service client explicitly so routes/pages stay
 * auditable, and membership is always derived from advertiser_members — never
 * from client-supplied org ids without verification.
 */

export type AdsDb = SupabaseClient;

export type AdvertiserRole = "owner" | "admin" | "member";
export const ROLE_RANK: Record<AdvertiserRole, number> = { member: 1, admin: 2, owner: 3 };
export const roleAtLeast = (have: AdvertiserRole, min: AdvertiserRole) => ROLE_RANK[have] >= ROLE_RANK[min];

export type AdvertiserOrg = {
  id: string;
  name: string;
  contact_email: string;
  billing_email: string | null;
  website: string | null;
  status: "pending" | "active" | "suspended";
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Membership = { org: AdvertiserOrg; role: AdvertiserRole };
export type AdvertiserContext = { user: SessionUser; memberships: Membership[] };

const ORG_COLS = "id,name,contact_email,billing_email,website,status,stripe_customer_id,created_at,updated_at";

type MemberRow = { role: string; advertiser_orgs: AdvertiserOrg | AdvertiserOrg[] | null };

function toMembership(row: MemberRow): Membership | null {
  const org = Array.isArray(row.advertiser_orgs) ? row.advertiser_orgs[0] : row.advertiser_orgs;
  if (!org || (row.role !== "owner" && row.role !== "admin" && row.role !== "member")) return null;
  return { org, role: row.role };
}

/** Session user's advertiser org memberships. null when signed out or backend missing. */
export async function getAdvertiserContext(): Promise<AdvertiserContext | null> {
  const user = await getSessionUser();
  const db = serviceClient();
  if (!user || !db) return null;
  const { data, error } = await db
    .from("advertiser_members")
    .select(`role, advertiser_orgs(${ORG_COLS})`)
    .eq("profile_id", user.id);
  if (error) return { user, memberships: [] };
  const memberships = ((data ?? []) as unknown as MemberRow[])
    .map(toMembership)
    .filter((m): m is Membership => m !== null);
  return { user, memberships };
}

/**
 * Resolves { user, org, role } for the session user. When orgId is given the
 * membership in THAT org must exist and meet minRole; otherwise the highest-role
 * membership that meets minRole wins. Returns null when unauthorized.
 */
export async function requireAdvertiserRole(
  minRole: AdvertiserRole,
  orgId?: string | null,
): Promise<{ user: SessionUser; org: AdvertiserOrg; role: AdvertiserRole; db: AdsDb } | null> {
  const ctx = await getAdvertiserContext();
  const db = serviceClient();
  if (!ctx || !db) return null;
  const match = ctx.memberships
    .filter((m) => roleAtLeast(m.role, minRole) && (!orgId || m.org.id === orgId))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];
  return match ? { user: ctx.user, org: match.org, role: match.role, db } : null;
}

export type AdvertiserPageCtx =
  | { kind: "no_user" }
  | { kind: "no_db"; user: SessionUser }
  | { kind: "no_org"; user: SessionUser; memberships: [] }
  | { kind: "ok"; user: SessionUser; org: AdvertiserOrg; role: AdvertiserRole; memberships: Membership[]; db: AdsDb };

/**
 * Page-level context: resolves the session user, their memberships, and the
 * selected org (via ?org= or the first/highest-role membership). Pages map the
 * `kind` to redirect/onboarding/empty states.
 */
export async function getAdvertiserPageContext(orgParam?: string | null): Promise<AdvertiserPageCtx> {
  const ctx = await getAdvertiserContext();
  if (!ctx) {
    const user = await getSessionUser();
    return user ? { kind: "no_db", user } : { kind: "no_user" };
  }
  if (!ctx.memberships.length) return { kind: "no_org", user: ctx.user, memberships: [] };
  const db = serviceClient();
  if (!db) return { kind: "no_db", user: ctx.user };
  const pick = ctx.memberships.find((m) => m.org.id === orgParam)
    ?? [...ctx.memberships].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];
  return { kind: "ok", user: ctx.user, org: pick.org, role: pick.role, memberships: ctx.memberships, db };
}

/* ─── Rate cards & pricing ─────────────────────────────────────────────────── */

export type AdRateCard = {
  id: string;
  placement: "kiosk_screen" | "website" | "email" | "event";
  pricing_model: "fixed" | "cpm" | "cpc";
  unit_price_cents: number;
  min_spend_cents: number;
  duration_days: number;
  active: boolean;
  note: string | null;
};

export async function listRateCards(db: AdsDb): Promise<AdRateCard[]> {
  const { data, error } = await db.from("ad_rate_cards").select("*").eq("active", true).order("placement");
  if (error) return [];
  return (data ?? []) as AdRateCard[];
}

export type PriceQuery = {
  placement: string;
  model: string;
  stations?: number;
  days?: number;
};

export type PriceResult = {
  rateCard: AdRateCard;
  unitRateCents: number;
  minSpendCents: number;
  /** fixed → total for the flight; cpm/cpc → null (unit rate + min spend are display-only). */
  totalCents: number | null;
};

/** Pure pricing: no card for placement+model → null (UI shows "contact us"). */
export function computePrice(cards: AdRateCard[], q: PriceQuery): PriceResult | null {
  const card = cards.find((c) => c.placement === q.placement && c.pricing_model === q.model);
  if (!card) return null;
  const days = Math.max(1, Math.round(q.days ?? card.duration_days));
  const total = card.pricing_model === "fixed"
    ? Math.max(card.unit_price_cents * days, card.min_spend_cents)
    : null;
  return { rateCard: card, unitRateCents: card.unit_price_cents, minSpendCents: card.min_spend_cents, totalCents: total };
}

export async function priceCampaign(db: AdsDb, q: PriceQuery): Promise<PriceResult | null> {
  return computePrice(await listRateCards(db), q);
}

/* ─── Eligible stations (public-safe fields only) ──────────────────────────── */

export type Targeting = {
  station_ids?: string[];
  venue_ids?: string[];
  cities?: string[];
  venue_types?: string[];
  /** chosen rate-card placement, stored inside targeting jsonb (no dedicated column) */
  placement?: string;
};

export type Schedule = {
  starts_at?: string;
  ends_at?: string;
  timezone?: string;
  dayparts?: string[];
};

export type EligibleStation = {
  id: string;
  stationId: string;
  venueId: string | null;
  venueName: string;
  city: string;
  venueType: string;
};

type KioskVenueRow = {
  id: string;
  station_id: string;
  venue_id: string | null;
  venues: { id: string; name: string; city: string; venue_type: string; published: boolean } | null;
};

const norm = (s: string) => s.trim().toLowerCase();

/** Pure targeting filter over kiosk→venue rows. Only published venues' online kiosks pass. */
export function filterStations(rows: KioskVenueRow[], t: Targeting): EligibleStation[] {
  const stationIds = new Set(t.station_ids ?? []);
  const venueIds = new Set(t.venue_ids ?? []);
  const cities = new Set((t.cities ?? []).map(norm));
  const types = new Set((t.venue_types ?? []).map(norm));
  const out: EligibleStation[] = [];
  for (const k of rows) {
    const v = k.venues;
    if (!v || v.published !== true) continue;
    if (stationIds.size && !stationIds.has(k.id)) continue;
    if (venueIds.size && !(k.venue_id && venueIds.has(k.venue_id))) continue;
    if (cities.size && !cities.has(norm(v.city))) continue;
    if (types.size && !types.has(norm(v.venue_type))) continue;
    out.push({ id: k.id, stationId: k.station_id, venueId: k.venue_id, venueName: v.name, city: v.city, venueType: v.venue_type });
  }
  return out;
}

/** Online kiosks at published venues, filtered by targeting. Never exposes operator internals. */
export async function eligibleStations(db: AdsDb, targeting: Targeting = {}): Promise<EligibleStation[]> {
  const { data, error } = await db
    .from("kiosks")
    .select("id, station_id, venue_id, venues!inner(id, name, city, venue_type, published)")
    .eq("state", "online")
    .eq("venues.published", true)
    .limit(1000);
  if (error) return [];
  return filterStations((data ?? []) as unknown as KioskVenueRow[], targeting);
}

/* ─── Campaigns ────────────────────────────────────────────────────────────── */

export type CampaignRow = {
  id: string;
  advertiser: string;
  name: string;
  status: "draft" | "pending_approval" | "approved" | "scheduled" | "live" | "paused" | "taken_down";
  starts_at: string | null;
  ends_at: string | null;
  advertiser_org_id: string | null;
  objective: string | null;
  budget_cents: number | null;
  spent_cents: number;
  pricing_model: "fixed" | "cpm" | "cpc" | "sponsored_credits";
  targeting: Targeting;
  schedule: Schedule;
  payment_status: "unpaid" | "checkout_pending" | "paid" | "failed" | "refunded";
  review_note: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  created_at: string;
};

export const CAMPAIGN_COLS =
  "id,advertiser,name,status,starts_at,ends_at,advertiser_org_id,objective,budget_cents,spent_cents,pricing_model,targeting,schedule,payment_status,review_note,submitted_at,approved_at,activated_at,created_at";

export type CampaignInput = {
  name: string;
  objective: string;
  pricing_model: CampaignRow["pricing_model"];
  targeting?: Targeting;
  schedule?: Schedule;
  budget_cents?: number | null;
};

export async function createCampaign(db: AdsDb, org: AdvertiserOrg, input: CampaignInput): Promise<{ id: string } | { error: string }> {
  const schedule = input.schedule ?? {};
  const { data, error } = await db.from("advertising_campaigns").insert({
    advertiser: org.name,
    name: input.name,
    advertiser_org_id: org.id,
    objective: input.objective,
    pricing_model: input.pricing_model,
    targeting: input.targeting ?? {},
    schedule,
    starts_at: schedule.starts_at ?? null,
    ends_at: schedule.ends_at ?? null,
    budget_cents: input.budget_cents ?? null,
    status: "draft",
    payment_status: "unpaid",
  }).select("id").single();
  if (error || !data) return { error: "Couldn't create the campaign." };
  return { id: (data as { id: string }).id };
}

export async function getCampaign(db: AdsDb, id: string): Promise<CampaignRow | null> {
  const { data, error } = await db.from("advertising_campaigns").select(CAMPAIGN_COLS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as unknown as CampaignRow;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/** draft → pending_approval. Requires a real budget and at least one submitted/approved creative. */
export async function submitCampaign(db: AdsDb, campaign: CampaignRow): Promise<SubmitResult> {
  if (campaign.status !== "draft") return { ok: false, error: "Only draft campaigns can be submitted." };
  if (!campaign.budget_cents || campaign.budget_cents <= 0) return { ok: false, error: "Set a budget before submitting." };
  const { count, error } = await db
    .from("ad_creatives")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .in("status", ["submitted", "approved"]);
  if (error) return { ok: false, error: "Couldn't check creatives." };
  if (!count) return { ok: false, error: "Add at least one creative before submitting." };
  const { error: upErr } = await db
    .from("advertising_campaigns")
    .update({ status: "pending_approval", submitted_at: new Date().toISOString() })
    .eq("id", campaign.id)
    .eq("status", "draft");
  if (upErr) return { ok: false, error: "Couldn't submit the campaign." };
  return { ok: true };
}

/* ─── Creative validation (pure — unit-tested) ─────────────────────────────── */

export const CREATIVE_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 50 * 1024 * 1024,
  headline: 120,
  body: 1000,
  url: 500,
} as const;

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const VIDEO_MIMES = ["video/mp4"] as const;

/** Strips HTML tags and collapses whitespace — creatives are plain text. */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}

export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

export type TextCreativeInput = { headline?: string; body?: string; destination_url?: string };

/** Validates + sanitizes a text creative. Returns cleaned fields or an error string. */
export function validateTextCreative(input: TextCreativeInput): { ok: true; headline: string; body: string; destination_url: string | null } | { ok: false; error: string } {
  const headline = stripHtml(input.headline ?? "");
  const body = stripHtml(input.body ?? "");
  const url = (input.destination_url ?? "").trim();
  if (!headline && !body) return { ok: false, error: "Add a headline or body." };
  if (headline.length > CREATIVE_LIMITS.headline) return { ok: false, error: `Headline must be ${CREATIVE_LIMITS.headline} characters or fewer.` };
  if (body.length > CREATIVE_LIMITS.body) return { ok: false, error: `Body must be ${CREATIVE_LIMITS.body} characters or fewer.` };
  if (url && (!isHttpsUrl(url) || url.length > CREATIVE_LIMITS.url)) return { ok: false, error: "Destination URL must be a valid https:// link." };
  return { ok: true, headline, body, destination_url: url || null };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (b: Uint8Array, sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);

/** Magic-byte sniffing for the allowed creative media types. */
export function sniffMediaMime(buf: Uint8Array): string | null {
  if (startsWith(buf, PNG_SIG)) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // WebP: "RIFF"...."WEBP"
  if (buf.length >= 12 && startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // MP4/MOV-family: bytes 4..8 == "ftyp"
  if (buf.length >= 12 && startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return "video/mp4";
  return null;
}

export const extForMime = (mime: string) =>
  ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" })[mime] ?? "bin";

/**
 * Validates uploaded creative media. `buf` is the decoded file. Returns the
 * sniffed mime on success — the declared client mime is never trusted.
 */
export function validateMediaCreative(kind: "image" | "video", buf: Uint8Array): { ok: true; mime: string; bytes: number } | { ok: false; error: string } {
  const cap = kind === "image" ? CREATIVE_LIMITS.imageBytes : CREATIVE_LIMITS.videoBytes;
  const capLabel = kind === "image" ? "5 MB" : "50 MB";
  if (!buf.length) return { ok: false, error: "Empty file." };
  if (buf.length > cap) return { ok: false, error: `Files must be ${capLabel} or smaller.` };
  const mime = sniffMediaMime(buf);
  const allowed = kind === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  if (!mime || !(allowed as readonly string[]).includes(mime)) {
    return { ok: false, error: kind === "image" ? "Images must be PNG, JPEG or WebP." : "Videos must be MP4." };
  }
  return { ok: true, mime, bytes: buf.length };
}
