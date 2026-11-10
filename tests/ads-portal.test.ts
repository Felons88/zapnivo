import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, dbHolder } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbHolder: { db: null as unknown },
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => session.user,
  isStaff: () => false,
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => dbHolder.db, anonClient: () => null, backendConfigured: () => true }));

import {
  computePrice, filterStations, roleAtLeast, ROLE_RANK,
  sniffMediaMime, stripHtml, validateMediaCreative, validateTextCreative,
  requireAdvertiserRole, type AdRateCard, type Targeting,
} from "@/lib/ads/service";

const ORG = { id: "org-1", name: "Acme", contact_email: "a@x.com", billing_email: null, website: null, status: "active", stripe_customer_id: null, created_at: "", updated_at: "" } as const;
const ORG2 = { ...ORG, id: "org-2", name: "Beta" };

const card = (over: Partial<AdRateCard> = {}): AdRateCard => ({
  id: "rc-1", placement: "kiosk_screen", pricing_model: "fixed",
  unit_price_cents: 10000, min_spend_cents: 25000, duration_days: 7, active: true, note: null, ...over,
});

describe("computePrice", () => {
  it("returns null when no rate card matches placement+model", () => {
    expect(computePrice([], { placement: "kiosk_screen", model: "fixed" })).toBeNull();
    expect(computePrice([card()], { placement: "website", model: "fixed" })).toBeNull();
    expect(computePrice([card()], { placement: "kiosk_screen", model: "cpm" })).toBeNull();
  });
  it("fixed model = unit × days, floored at min spend", () => {
    const p = computePrice([card()], { placement: "kiosk_screen", model: "fixed", days: 3 });
    expect(p?.totalCents).toBe(30000);
    const floored = computePrice([card({ unit_price_cents: 1000 })], { placement: "kiosk_screen", model: "fixed", days: 1 });
    expect(floored?.totalCents).toBe(25000); // 1000 < min_spend 25000
  });
  it("defaults days to the card's duration_days", () => {
    expect(computePrice([card()], { placement: "kiosk_screen", model: "fixed" })?.totalCents).toBe(70000);
  });
  it("cpm/cpc return unit rate + min spend with null total (display only)", () => {
    const p = computePrice([card({ pricing_model: "cpm", unit_price_cents: 500 })], { placement: "kiosk_screen", model: "cpm", days: 7 });
    expect(p?.totalCents).toBeNull();
    expect(p?.unitRateCents).toBe(500);
    expect(p?.minSpendCents).toBe(25000);
  });
});

const kiosk = (id: string, over: Record<string, unknown> = {}) => ({
  id, station_id: `ST-${id}`, venue_id: `v-${id}`,
  venues: { id: `v-${id}`, name: `Venue ${id}`, city: "Minneapolis", venue_type: "Bar", published: true },
  ...over,
});

describe("filterStations", () => {
  const rows = [
    kiosk("k1"),
    kiosk("k2", { venues: { id: "v-k2", name: "Cafe", city: "Duluth", venue_type: "Restaurant", published: true } }),
    kiosk("k3", { venues: { id: "v-k3", name: "Hidden", city: "Minneapolis", venue_type: "Bar", published: false } }),
  ];
  it("returns all published-venue kiosks with no targeting", () => {
    const out = filterStations(rows as never, {});
    expect(out.map((s) => s.id).sort()).toEqual(["k1", "k2"]);
    expect(out[0]).not.toHaveProperty("state"); // no operator internals
  });
  it("filters by city case-insensitively", () => {
    const t: Targeting = { cities: ["duluth"] };
    expect(filterStations(rows as never, t).map((s) => s.id)).toEqual(["k2"]);
  });
  it("filters by venue_type and station_ids", () => {
    expect(filterStations(rows as never, { venue_types: ["Restaurant"] }).map((s) => s.id)).toEqual(["k2"]);
    expect(filterStations(rows as never, { station_ids: ["k1"] }).map((s) => s.id)).toEqual(["k1"]);
    expect(filterStations(rows as never, { venue_ids: ["v-k2"] }).map((s) => s.id)).toEqual(["k2"]);
  });
});

describe("creative validation", () => {
  it("strips HTML from text creatives", () => {
    const v = validateTextCreative({ headline: "<b>Hi</b> there", body: "<script>x()</script> body &amp; more" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.headline).toBe("Hi there");
      expect(v.body).toBe("x() body & more");
    }
    expect(stripHtml("<i>a</i> <b>b</b>")).toBe("a b");
  });
  it("rejects non-https destination URLs", () => {
    for (const url of ["javascript:alert(1)", "http://x.com", "notaurl", "ftp://x.com"]) {
      expect(validateTextCreative({ headline: "Hi", destination_url: url }).ok).toBe(false);
    }
    expect(validateTextCreative({ headline: "Hi", destination_url: "https://example.com/x" }).ok).toBe(true);
  });
  it("requires some text content", () => {
    expect(validateTextCreative({}).ok).toBe(false);
    expect(validateTextCreative({ headline: "   " }).ok).toBe(false);
  });
  it("sniffs PNG/JPEG/WebP/MP4 magic bytes", () => {
    expect(sniffMediaMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffMediaMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    const webp = new Uint8Array(16); webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffMediaMime(webp)).toBe("image/webp");
    const mp4 = new Uint8Array(16); mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(sniffMediaMime(mp4)).toBe("video/mp4");
    expect(sniffMediaMime(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });
  it("rejects bad mime and oversize media", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateMediaCreative("image", png).ok).toBe(true);
    expect(validateMediaCreative("image", new TextEncoder().encode("plain text")).ok).toBe(false);
    expect(validateMediaCreative("video", png).ok).toBe(false); // png isn't mp4
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(png, 0);
    expect(validateMediaCreative("image", big).ok).toBe(false);
    expect(validateMediaCreative("image", new Uint8Array(0)).ok).toBe(false);
  });
});

describe("membership roles", () => {
  it("orders owner > admin > member", () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeGreaterThan(ROLE_RANK.member);
    expect(roleAtLeast("owner", "member")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("admin", "admin")).toBe(true);
  });

  function fakeDb(rows: unknown[]) {
    return { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }) };
  }

  beforeEach(() => { session.user = { id: "u1", email: "a@x.com", role: "customer", organizationId: null }; dbHolder.db = null; });

  it("returns null when signed out or backend missing", async () => {
    expect(await requireAdvertiserRole("member")).toBeNull();
    session.user = { id: "u1", email: "a@x.com", role: "customer", organizationId: null };
    dbHolder.db = fakeDb([]);
    expect(await requireAdvertiserRole("member")).toBeNull();
  });

  it("picks the highest-role membership meeting minRole, honoring orgId", async () => {
    dbHolder.db = fakeDb([
      { role: "member", advertiser_orgs: ORG },
      { role: "owner", advertiser_orgs: ORG2 },
    ]);
    const admin = await requireAdvertiserRole("admin");
    expect(admin?.org.id).toBe("org-2");
    expect(admin?.role).toBe("owner");
    const memberOnly = await requireAdvertiserRole("admin", "org-1");
    expect(memberOnly).toBeNull();
    const scoped = await requireAdvertiserRole("member", "org-1");
    expect(scoped?.org.id).toBe("org-1");
    expect(scoped?.role).toBe("member");
  });
});
