import { beforeEach, describe, expect, it, vi } from "vitest";

const { service } = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));
import { getStations } from "@/lib/stations";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";

const venue = {
  name: "Verified Venue", venue_type: "bar", street: "100 Main St", city: "St. Cloud", state: "MN", zip: "56301",
  hours: "Daily", lat: 45.56, lng: -94.16,
  phone: null, website: null, description: null, accessibility: null,
};

const NOW = Date.now();
const FRESH = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - (HEARTBEAT_STALE_MIN + 10) * 60_000).toISOString();
const INSTALLED = "2026-01-01T00:00:00Z";

type Kiosk = {
  station_id: string; state: string; installed_at: string | null;
  last_seen_at?: string | null; slot_count?: number; test_mode?: boolean;
  kiosk_slots?: { state: string; power_bank_id: string | null }[];
};

/** Chainable stand-in for the venues→kiosks query (any .eq() resolves to the same result). */
function result(kiosks: Kiosk[]) {
  const data = [{ ...venue, kiosks }];
  const q: Record<string, unknown> = { data, error: null };
  q.eq = () => q;
  service.mockReturnValue({ from: () => ({ select: () => q }) });
}

describe("public station map", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not expose a newly registered provisioning kiosk", async () => {
    result([{ station_id: "ZN-NEW", state: "provisioning", installed_at: null }]);
    expect(await getStations()).toEqual([]);
  });

  it("lists installed kiosks with honest availability, including offline ones", async () => {
    result([
      { station_id: "ZN-LIVE", state: "online", installed_at: INSTALLED, last_seen_at: FRESH,
        kiosk_slots: [{ state: "ready", power_bank_id: "b1" }, { state: "empty", power_bank_id: null }] },
      { station_id: "ZN-OFFLINE", state: "offline", installed_at: INSTALLED, last_seen_at: STALE },
    ]);
    const out = await getStations();
    expect(out.map((s) => s.id)).toEqual(["ZN-LIVE", "ZN-OFFLINE"]);
    expect(out[0]).toMatchObject({ station_state: "available", ready_banks: 1, rentals_available: true });
    expect(out[1]).toMatchObject({ station_state: "offline", rentals_available: false });
  });

  it("marks stale telemetry as unconfirmed — never available", async () => {
    result([{ station_id: "ZN-QUIET", state: "online", installed_at: INSTALLED, last_seen_at: STALE,
      kiosk_slots: [{ state: "ready", power_bank_id: "b1" }] }]);
    const [s] = await getStations();
    expect(s.station_state).toBe("stale");
    expect(s.rentals_available).toBe(false);
  });

  it("never lists test-mode kiosks publicly", async () => {
    result([{ station_id: "ZN-TEST", state: "online", installed_at: INSTALLED, last_seen_at: FRESH, test_mode: true }]);
    expect(await getStations()).toEqual([]);
  });
});
