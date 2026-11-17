/**
 * Server-side Mapbox Search Box API client.
 *
 * Kept behind /api/system/mapbox/* so autocomplete traffic is rate-limited,
 * logged, and never exposes anything beyond what the admin UI needs. A public
 * token still powers client maps (URL-restricted); a secret token may be set
 * for server calls via MAPBOX_TOKEN — otherwise the public token is used, which
 * is fine because Search Box accepts pk.* tokens too.
 *
 * Mapbox terms: results may be cached to populate a venue record but must not
 * be used to build a separate places database — mapbox_id + coordinates are
 * stored on the venue row (allowed for persistent display of that record).
 * "Powered by Mapbox" attribution is rendered in the admin form.
 */

const SUGGEST_URL = "https://api.mapbox.com/search/searchbox/v1/suggest";
const RETRIEVE_URL = "https://api.mapbox.com/search/searchbox/v1/retrieve";

/** Minnesota + border bias so "McCoy's Pub" lands on Elk River, MN first. */
const MN_BBOX = "-97.3,43.3,-89.4,49.6";
const MN_CENTER = "-94.3,46.3";

export function mapboxToken(): string | null {
  return process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || null;
}
export const mapboxConfigured = () => mapboxToken() != null;

export type MapboxSuggestion = {
  mapbox_id: string;
  name: string;
  place_formatted: string | null;
  address: string | null;
  feature_type: string | null;
  /** Raw Mapbox poi_category / maki hints, kept for venue-type mapping. */
  categories: string[];
};

export type MapboxVenueDetails = {
  mapbox_id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  phone: string | null;
  website: string | null;
  /** Free-text hours when Mapbox metadata provides them (often absent). */
  hours: string | null;
  /** Accessibility note when Mapbox reports wheelchair accessibility. */
  accessibility: string | null;
  /** Mapbox primary photo — usable as the venue cover image. */
  cover_image_url: string | null;
};

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ctxName = (ctx: unknown, key: string): string | null => {
  const c = (ctx as Json | undefined)?.[key] as Json | undefined;
  return str(c?.name);
};

/** Mapbox Search Box uses a session token to group suggest → retrieve into one billed session. */
export function newSessionToken(): string {
  return crypto.randomUUID();
}

async function mapboxFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(url, { signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

export async function mapboxSuggest(query: string, sessionToken: string, limit = 6): Promise<MapboxSuggestion[] | null> {
  const token = mapboxToken();
  const q = query.trim();
  if (!token || q.length < 2) return [];
  const params = new URLSearchParams({
    q, access_token: token, session_token: sessionToken,
    limit: String(Math.min(10, Math.max(1, limit))),
    country: "us", bbox: MN_BBOX, proximity: MN_CENTER,
    // poi + address covers venues AND bare-address searches.
    types: "poi,address,place,locality",
    language: "en",
  });
  let res: Response;
  try {
    res = await mapboxFetch(`${SUGGEST_URL}?${params}`);
  } catch {
    return null; // network failure — caller degrades to manual entry
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { suggestions?: Json[] } | null;
  return (body?.suggestions ?? [])
    .map((s): MapboxSuggestion | null => {
      const id = str(s.mapbox_id);
      const name = str(s.name);
      if (!id || !name) return null;
      return {
        mapbox_id: id,
        name,
        place_formatted: str(s.place_formatted),
        address: str(s.address),
        feature_type: str(s.feature_type),
        categories: Array.isArray(s.poi_category) ? (s.poi_category as unknown[]).filter((c): c is string => typeof c === "string") : [],
      };
    })
    .filter((s): s is MapboxSuggestion => s != null);
}

export async function mapboxRetrieve(mapboxId: string, sessionToken: string): Promise<MapboxVenueDetails | null> {
  const token = mapboxToken();
  if (!token || !/^[A-Za-z0-9_.=-]{8,120}$/.test(mapboxId)) return null;
  const params = new URLSearchParams({ access_token: token, session_token: sessionToken });
  let res: Response;
  try {
    res = await mapboxFetch(`${RETRIEVE_URL}/${encodeURIComponent(mapboxId)}?${params}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { features?: { properties?: Json }[] } | null;
  const p = body?.features?.[0]?.properties;
  if (!p) return null;
  const coords = p.coordinates as Json | undefined;
  const ctx = p.context as Json | undefined;
  const meta = p.metadata as Json | undefined;
  const addrCtx = ctx?.address as Json | undefined;

  const streetParts = [str(addrCtx?.address_number), str(addrCtx?.street_name)].filter(Boolean);
  const openHours = str(meta?.open_hours);
  return {
    mapbox_id: str(p.mapbox_id) ?? mapboxId,
    name: str(p.name) ?? "",
    street: streetParts.length ? streetParts.join(" ") : str(p.address),
    city: ctxName(ctx, "place"),
    state: ((): string | null => {
      const code = str((ctx?.region as Json | undefined)?.region_code);
      return code ? code.replace(/^US-/, "").slice(0, 2).toUpperCase() : null;
    })(),
    zip: ctxName(ctx, "postcode"),
    lat: num(coords?.latitude),
    lng: num(coords?.longitude),
    categories: Array.isArray(p.poi_category) ? (p.poi_category as unknown[]).filter((c): c is string => typeof c === "string") : [],
    phone: str(meta?.phone),
    website: str(meta?.website),
    // Mapbox rarely returns hours; when it does it's open_hours metadata.
    hours: openHours,
    accessibility: meta?.wheelchair_accessible === true ? "Wheelchair accessible" : null,
    cover_image_url: str(meta?.primary_photo),
  };
}

/** Zapnivo's public venue types — the admin form's Type select. */
export const VENUE_TYPES = [
  "bar", "restaurant", "cafe", "nightclub", "brewery",
  "shopping_mall", "retail", "convenience_store", "gas_station",
  "hotel", "gym", "entertainment", "event_venue", "campus", "transport", "other",
] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

const CATEGORY_MAP: [RegExp, VenueType][] = [
  [/night ?club|club|disco/i, "nightclub"],
  [/bar|pub|tavern|lounge|saloon|cocktail/i, "bar"],
  [/brewery|distillery|winery|tap ?room/i, "brewery"],
  [/coffee|caf[ée]|espresso|tea/i, "cafe"],
  [/restaurant|diner|eater|grill|pizza|burger|sushi|taco|food|dining|bbq|steak/i, "restaurant"],
  [/mall|shopping|outlet|department/i, "shopping_mall"],
  [/convenience|corner store|bodega/i, "convenience_store"],
  [/gas|fuel|petrol|service station/i, "gas_station"],
  [/hotel|motel|inn|lodg|resort/i, "hotel"],
  [/gym|fitness|health club|yoga|climbing/i, "gym"],
  [/cinema|movie|theater|bowling|arcade|casino|amusement|golf|entertainment/i, "entertainment"],
  [/stadium|arena|event|concert|venue|fairground|convention/i, "event_venue"],
  [/college|university|campus|school/i, "campus"],
  [/airport|station|transit|terminal|bus|train/i, "transport"],
  [/shop|store|retail|market|supermarket|grocery|liquor/i, "retail"],
];

/** Best-effort Mapbox poi_category → Zapnivo venue_type. Always returns a type; 'other' when unsure. */
export function mapVenueType(categories: string[], mapboxFeatureType?: string | null): VenueType {
  for (const cat of categories) for (const [re, type] of CATEGORY_MAP) if (re.test(cat)) return type;
  if (mapboxFeatureType && /address|street/i.test(mapboxFeatureType)) return "other";
  return "other";
}
