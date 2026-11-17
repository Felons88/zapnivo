import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mapVenueType, VENUE_TYPES } from "@/lib/mapbox";
import { matchVenueDuplicates } from "@/app/api/system/venues/duplicates/route";
import { missingPublishFields } from "@/lib/venues";
import { stationStateOf, STATE_LABEL } from "@/lib/stations";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";

/* ── Mapbox venue-type mapping ─────────────────────────────────────── */

describe("mapVenueType", () => {
  it("maps common Minnesota venue categories", () => {
    expect(mapVenueType(["bar", "pub"])).toBe("bar");
    expect(mapVenueType(["nightclub"])).toBe("nightclub");
    expect(mapVenueType(["shopping_mall", "clothing_store"])).toBe("shopping_mall");
    expect(mapVenueType(["convenience_store"])).toBe("convenience_store");
    expect(mapVenueType(["coffee_shop"])).toBe("cafe");
    expect(mapVenueType(["restaurant"])).toBe("restaurant");
    expect(mapVenueType(["bowling_alley"])).toBe("entertainment");
    expect(mapVenueType(["gas_station"])).toBe("gas_station");
  });

  it("falls back to 'other' for unknown categories — never guesses", () => {
    expect(mapVenueType(["dentist", "medical"])).toBe("other");
    expect(mapVenueType([])).toBe("other");
  });

  it("every returned type is a supported venue type", () => {
    for (const cats of [["bar"], ["hotel"], ["gym"], ["university"], ["airport"], ["x_y_z"]]) {
      expect(VENUE_TYPES).toContain(mapVenueType(cats));
    }
  });
});

/* ── Duplicate detection ───────────────────────────────────────────── */

describe("matchVenueDuplicates", () => {
  const rows = [
    { id: "v1", name: "McCoy's Pub", city: "Elk River", state: "MN", lat: 45.30, lng: -93.57, mapbox_id: "mbx.1" },
    { id: "v2", name: "McCoy's Pub", city: "Minneapolis", state: "MN", lat: 44.98, lng: -93.27, mapbox_id: "mbx.2" },
  ];

  it("flags the same mapbox_id anywhere", () => {
    const d = matchVenueDuplicates({ name: "Anything", mapbox_id: "mbx.1" }, rows);
    expect(d.map((m) => m.why)).toEqual(["mapbox_id"]);
  });

  it("flags venues within ~75m regardless of name", () => {
    const d = matchVenueDuplicates({ name: "Renamed Pub", lat: 45.3002, lng: -93.5702 }, rows);
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe("v1");
    expect(d[0].why).toBe("location");
  });

  it("flags same normalized name in the same city+state only", () => {
    expect(matchVenueDuplicates({ name: "mccoys pub", city: "Elk River", state: "mn" }, rows)).toHaveLength(1);
    expect(matchVenueDuplicates({ name: "McCoy's Pub", city: "Duluth", state: "MN" }, rows)).toHaveLength(0);
  });

  it("does not flag the same name in a different city or different name in same city", () => {
    expect(matchVenueDuplicates({ name: "McCoy's Pub", city: "Minneapolis", state: "MN" }, rows)).toHaveLength(1); // matches v2
    expect(matchVenueDuplicates({ name: "Other Bar", city: "Elk River", state: "MN" }, rows)).toHaveLength(0);
  });
});

/* ── Publish gating ────────────────────────────────────────────────── */

describe("missingPublishFields", () => {
  it("requires name, full address, and coordinates", () => {
    expect(missingPublishFields({})).toEqual(["name", "street", "city", "state", "coordinates"]);
    expect(missingPublishFields({ name: "V", street: "1 Main", city: "Elk River", state: "MN", lat: 45.3, lng: -93.5 })).toEqual([]);
    expect(missingPublishFields({ name: "V", street: "1 Main", city: "Elk River", state: "MN" })).toEqual(["coordinates"]);
    expect(missingPublishFields({ name: "V", street: "1 Main", city: "Elk River", state: "Minnesota", lat: 1, lng: 1 })).toEqual(["state"]);
  });
});

/* ── Public station status honesty ─────────────────────────────────── */

describe("stationStateOf", () => {
  const now = Date.parse("2026-02-01T12:00:00Z");
  const fresh = new Date(now - 2 * 60_000).toISOString();
  const stale = new Date(now - (HEARTBEAT_STALE_MIN + 5) * 60_000).toISOString();
  const installed = "2026-01-01T00:00:00Z";

  it("never lists a kiosk that was never installed", () => {
    expect(stationStateOf({ state: "online", installed_at: null, last_seen_at: fresh }, now)).toBeNull();
  });

  it("online + fresh heartbeat = available; stale heartbeat = stale, NOT available", () => {
    expect(stationStateOf({ state: "online", installed_at: installed, last_seen_at: fresh }, now)).toBe("available");
    expect(stationStateOf({ state: "online", installed_at: installed, last_seen_at: stale }, now)).toBe("stale");
    expect(stationStateOf({ state: "online", installed_at: installed, last_seen_at: null }, now)).toBe("stale");
  });

  it("offline and maintenance report their real state", () => {
    expect(stationStateOf({ state: "offline", installed_at: installed, last_seen_at: stale }, now)).toBe("offline");
    expect(stationStateOf({ state: "maintenance", installed_at: installed, last_seen_at: fresh }, now)).toBe("maintenance");
    expect(STATE_LABEL.stale).toMatch(/unconfirmed/i);
  });
});

/* ── Mapbox client: network failures degrade, never throw ──────────── */

describe("mapbox client degradation", () => {
  beforeEach(() => { vi.stubEnv("MAPBOX_TOKEN", ""); vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", ""); });
  afterEach(() => vi.unstubAllEnvs());

  it("returns empty suggestions with no token configured", async () => {
    const { mapboxSuggest, mapboxRetrieve, mapboxConfigured } = await import("@/lib/mapbox");
    expect(mapboxConfigured()).toBe(false);
    expect(await mapboxSuggest("McCoy's Pub", crypto.randomUUID())).toEqual([]);
    expect(await mapboxRetrieve("mbx.12345678", crypto.randomUUID())).toBeNull();
  });
});
