import { describe, expect, it } from "vitest";
import { isCampaignDeliverable, campaignTargetsKiosk } from "@/lib/ads/eligibility";

const NOW = new Date("2026-06-15T12:00:00Z");
const base = {
  id: "c1", status: "live", payment_status: "paid",
  targeting: {}, schedule: {}, starts_at: null, ends_at: null,
};

describe("isCampaignDeliverable", () => {
  it("accepts paid live/scheduled campaigns in window", () => {
    expect(isCampaignDeliverable(base, NOW)).toBe(true);
    expect(isCampaignDeliverable({ ...base, status: "scheduled" }, NOW)).toBe(true);
  });
  it("rejects unpaid, draft, taken_down, pending", () => {
    for (const status of ["draft", "pending_approval", "approved", "paused", "taken_down"]) {
      expect(isCampaignDeliverable({ ...base, status }, NOW)).toBe(false);
    }
    for (const p of ["unpaid", "checkout_pending", "failed", "refunded"]) {
      expect(isCampaignDeliverable({ ...base, payment_status: p }, NOW)).toBe(false);
    }
  });
  it("enforces schedule window from jsonb then legacy columns", () => {
    expect(isCampaignDeliverable({ ...base, schedule: { starts_at: "2026-06-16T00:00:00Z" } }, NOW)).toBe(false);
    expect(isCampaignDeliverable({ ...base, schedule: { ends_at: "2026-06-14T00:00:00Z" } }, NOW)).toBe(false);
    expect(isCampaignDeliverable({ ...base, starts_at: "2026-06-01T00:00:00Z", ends_at: "2026-06-30T00:00:00Z" }, NOW)).toBe(true);
    expect(isCampaignDeliverable({ ...base, ends_at: "2026-06-01T00:00:00Z" }, NOW)).toBe(false);
  });
});

describe("campaignTargetsKiosk", () => {
  const db = {} as never; // targeting match is pure given venue row
  const kiosk = { id: "k-1", venue_id: "v-1" };
  const venue = { id: "v-1", city: "Austin", venue_type: "bar" };

  it("empty targeting reaches every kiosk", async () => {
    expect(await campaignTargetsKiosk(db, base, kiosk, venue)).toBe(true);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { station_ids: [] } }, kiosk, venue)).toBe(true);
  });
  it("matches station_ids, venue_ids, cities, venue_types", async () => {
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { station_ids: ["k-1"] } }, kiosk, venue)).toBe(true);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { station_ids: ["other"] } }, kiosk, venue)).toBe(false);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { venue_ids: ["v-1"] } }, kiosk, venue)).toBe(true);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { cities: ["austin"] } }, kiosk, venue)).toBe(true);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { venue_types: ["BAR"] } }, kiosk, venue)).toBe(true);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { cities: ["Dallas"] } }, kiosk, venue)).toBe(false);
  });
  it("missing venue only matches station-level targeting", async () => {
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { cities: ["Austin"] } }, kiosk, null)).toBe(false);
    expect(await campaignTargetsKiosk(db, { ...base, targeting: { station_ids: ["k-1"] } }, kiosk, null)).toBe(true);
  });
});
