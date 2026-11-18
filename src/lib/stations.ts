import { HEARTBEAT_STALE_MIN } from "./kiosk/heartbeat";

/** Honest operational status — never implies availability we can't verify. */
export type StationState = "available" | "offline" | "maintenance" | "stale";

export type Station = {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  /** Null only for venue-less test stations — a bench device has no real pin. */
  lat: number | null;
  lng: number | null;
  /** True for test-mode kiosks — only ever sent to staff/tester callers. */
  test_mode?: boolean;
  hours: string | null;
  availability: string | null;
  /** Live operational status derived from real kiosk telemetry. */
  station_state: StationState;
  /** Power banks ready to rent right now (kiosk_slots.state = 'ready'). */
  ready_banks: number | null;
  slot_count: number | null;
  venue_type: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  accessibility: string | null;
  /** True only when a rental can plausibly start: live telemetry AND a ready bank. */
  rentals_available: boolean;
};

export const MINNESOTA_CENTER: [number, number] = [-94.3, 46.3];

type VenueJoin = {
  name: string; venue_type: string | null; street: string; city: string; state: string; zip: string | null;
  hours: string | null; lat: number | null; lng: number | null;
  phone: string | null; website: string | null; description: string | null; accessibility: string | null;
};
type KioskJoin = {
  station_id: string; state: string; installed_at: string | null; last_seen_at: string | null;
  slot_count: number; test_mode: boolean | null;
  kiosk_slots: { state: string; power_bank_id: string | null }[] | null;
};

const seenMs = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/** Derives the public status from a kiosk row. Stale telemetry → 'stale', never 'available'. */
export function stationStateOf(k: Pick<KioskJoin, "state" | "installed_at" | "last_seen_at">, now = Date.now()): StationState | null {
  if (!k.installed_at) return null; // never installed → not a public pin at all
  if (k.state === "maintenance") return "maintenance";
  if (k.state !== "online") return "offline";
  const seen = seenMs(k.last_seen_at);
  if (!Number.isFinite(seen) || now - seen > HEARTBEAT_STALE_MIN * 60_000) return "stale";
  return "available";
}

export const STATE_LABEL: Record<StationState, string> = {
  available: "Open now",
  offline: "Station offline",
  maintenance: "Under maintenance",
  stale: "Status unconfirmed",
};

/**
 * Live stations straight from the database: published + active venues that
 * have an installed kiosk. Offline/maintenance stations are returned too —
 * surfaces show their real status instead of hiding or faking availability.
 * Test-mode kiosks are never listed publicly; includeTest adds them clearly
 * marked (staff/tester callers only), including venue-less bench devices.
 * Server-only — call from server components/route handlers.
 */
export async function getStations(opts: { includeTest?: boolean } = {}): Promise<Station[]> {
  const { serviceClient } = await import("./supabase");
  const db = serviceClient();
  if (!db) return [];
  const includeTest = opts.includeTest === true;
  let q = db
    .from("venues")
    .select("name,venue_type,street,city,state,zip,hours,lat,lng,phone,website,description,accessibility,kiosks(station_id,state,installed_at,last_seen_at,slot_count,test_mode,kiosk_slots(state,power_bank_id))");
  if (!includeTest) q = q.eq("published", true).eq("active", true);
  const { data, error } = await q;
  if (error || !data) return [];
  const readyOf = (k: KioskJoin) => (k.kiosk_slots ?? []).filter((s) => s.state === "ready" && s.power_bank_id != null).length;
  const testStation = (k: KioskJoin, v: VenueJoin | null): Station => ({
    id: k.station_id,
    name: v?.name ?? `Test station ${k.station_id}`,
    address: v ? `${v.street}, ${v.city}, ${v.state}${v.zip ? ` ${v.zip}` : ""}` : "",
    city: v?.city ?? "", state: v?.state ?? "", zip: v?.zip ?? "",
    lat: v?.lat == null ? null : Number(v.lat), lng: v?.lng == null ? null : Number(v.lng),
    hours: v?.hours ?? null,
    availability: "Test mode — not a public location",
    station_state: stationStateOf(k) ?? "offline",
    ready_banks: readyOf(k),
    slot_count: k.slot_count,
    venue_type: v?.venue_type ?? null, phone: v?.phone ?? null, website: v?.website ?? null,
    description: v?.description ?? null, accessibility: v?.accessibility ?? null,
    // The server relaxes live gates for test-mode kiosks, so a test rental can
    // be started; the hardware state is still reported honestly above.
    rentals_available: true,
    test_mode: true,
  });
  const out: Station[] = [];
  const listed = new Set<string>();
  for (const v of data as (VenueJoin & { kiosks: KioskJoin[] | null })[]) {
    for (const k of v.kiosks ?? []) {
      if (k.test_mode === true) {
        if (includeTest) { listed.add(k.station_id); out.push(testStation(k, v)); }
        continue;
      }
      if (v.lat == null || v.lng == null) continue;
      const ss = stationStateOf(k);
      if (!ss) continue; // provisioning/disabled/never installed
      const ready = readyOf(k);
      out.push({
        id: k.station_id,
        name: v.name,
        address: `${v.street}, ${v.city}, ${v.state}${v.zip ? ` ${v.zip}` : ""}`,
        city: v.city, state: v.state, zip: v.zip ?? "",
        lat: Number(v.lat), lng: Number(v.lng),
        hours: v.hours,
        availability: ss === "available" ? (ready > 0 ? `${ready} charger${ready === 1 ? "" : "s"} ready` : "No chargers ready") : STATE_LABEL[ss],
        station_state: ss,
        ready_banks: ready,
        slot_count: k.slot_count,
        venue_type: v.venue_type, phone: v.phone, website: v.website,
        description: v.description, accessibility: v.accessibility,
        rentals_available: ss === "available" && ready > 0,
      });
    }
  }
  if (includeTest) {
    // Bench test kiosks with no venue have no real location — listed without
    // map coordinates so testers can still reach them from the list view.
    const { data: orphans } = await db
      .from("kiosks")
      .select("station_id,state,installed_at,last_seen_at,slot_count,test_mode,kiosk_slots(state,power_bank_id)")
      .eq("test_mode", true)
      .is("venue_id", null);
    for (const k of (orphans ?? []) as KioskJoin[]) {
      if (listed.has(k.station_id)) continue;
      out.push(testStation(k, null));
    }
  }
  return out;
}
