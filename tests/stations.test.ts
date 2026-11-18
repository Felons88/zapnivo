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

/** Chainable stand-in for the venues→kiosks query (any .eq()/.is() resolves to the same result). */
function result(kiosks: Kiosk[], orphans: Kiosk[] = []) {
  const q: Record<string, unknown> = { data: [{ ...venue, kiosks }], error: null };
  q.eq = () => q; q.is = () => q;
  const orphanQ: Record<string, unknown> = { data: orphans, error: null };
  orphanQ.eq = () => orphanQ; orphanQ.is = () => orphanQ;
  service.mockReturnValue({ from: (t: string) => ({ select: () => (t === "kiosks" ? orphanQ : q) }) });
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

  it("includeTest lists test kiosks clearly marked, with honest telemetry", async () => {
    result([{ station_id: "ZN-TEST", state: "offline", installed_at: INSTALLED, last_seen_at: FRESH, test_mode: true,
      kiosk_slots: [{ state: "ready", power_bank_id: "b1" }] }]);
    const [s] = await getStations({ includeTest: true });
    expect(s).toMatchObject({
      id: "ZN-TEST", test_mode: true, station_state: "offline",
      rentals_available: true, ready_banks: 1,
    });
    expect(s.availability).toContain("Test mode");
  });

  it("includeTest still lists venue-less bench kiosks without coordinates", async () => {
    result([], [{ station_id: "ZN-BENCH", state: "provisioning", installed_at: null, test_mode: true }]);
    const [s] = await getStations({ includeTest: true });
    expect(s).toMatchObject({ id: "ZN-BENCH", test_mode: true, lat: null, lng: null });
    expect(s.name).toContain("ZN-BENCH");
  });
});
