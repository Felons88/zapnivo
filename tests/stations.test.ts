import { beforeEach, describe, expect, it, vi } from "vitest";

const { service } = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));
import { getStations } from "@/lib/stations";

const venue = {
  name: "Verified Venue", street: "100 Main St", city: "St. Cloud", state: "MN", zip: "56301",
  hours: "Daily", lat: 45.56, lng: -94.16,
};

function result(kiosks: { station_id: string; state: string; installed_at: string | null }[]) {
  service.mockReturnValue({ from: () => ({ select: () => ({ eq: async () => ({ data: [{ ...venue, kiosks }], error: null }) }) }) });
}

describe("public station map", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not expose a newly registered provisioning kiosk", async () => {
    result([{ station_id: "ZN-NEW", state: "provisioning", installed_at: null }]);
    expect(await getStations()).toEqual([]);
  });

  it("only includes an installed kiosk reporting online", async () => {
    result([
      { station_id: "ZN-LIVE", state: "online", installed_at: "2026-11-09T12:00:00Z" },
      { station_id: "ZN-OFFLINE", state: "offline", installed_at: "2026-11-09T12:00:00Z" },
    ]);
    expect((await getStations()).map((s) => s.id)).toEqual(["ZN-LIVE"]);
  });
});
