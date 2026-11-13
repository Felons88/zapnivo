import { describe, expect, it } from "vitest";
import { consoleFor, decideAvailability, homeFor, incidentCategory, likeEscape, safeNext, shapeHistory, type HistoryRentalRow } from "@/lib/customer";
import { planRoute } from "@/lib/subdomains";

const venue = { name: "Demo Tavern", street: "1 Main", city: "Duluth", state: "MN", zip: "55802", hours: "10-2", published: true };
const kiosk = (o: object = {}) => ({ station_id: "S1", state: "online", installed_at: "2026-01-01", venues: venue, ...o });

describe("availability", () => {
  it("is available only for online, installed, published", () => {
    expect(decideAvailability(kiosk())).toMatchObject({ ok: true, venueName: "Demo Tavern" });
    expect(decideAvailability(null)).toEqual({ ok: false, reason: "unknown" });
    expect(decideAvailability(kiosk({ state: "offline" }))).toEqual({ ok: false, reason: "offline" });
    expect(decideAvailability(kiosk({ installed_at: null }))).toEqual({ ok: false, reason: "offline" });
    expect(decideAvailability(kiosk({ venues: { ...venue, published: false } }))).toEqual({ ok: false, reason: "unpublished" });
    expect(decideAvailability(kiosk({ venues: null }))).toEqual({ ok: false, reason: "unpublished" });
    expect(decideAvailability(kiosk(), false)).toEqual({ ok: false, reason: "unconfigured" });
  });
});

const rental = (ref: string, at: string): HistoryRentalRow => ({
  reference: ref, state: "returned", started_at: at, dispensed_at: at, returned_at: at, non_return_deadline: null,
  kiosks: { station_id: "S1", venues: { name: "Demo Tavern", city: "Duluth" } }, payments: [{ state: "captured", amount_captured_cents: 699 }],
});

describe("history shaping", () => {
  it("dedupes across profile and email matches, newest first, with links", () => {
    const h = shapeHistory([rental("ZR-AAAAAAAA", "2026-01-01T00:00:00Z")], [rental("ZR-AAAAAAAA", "2026-01-01T00:00:00Z"), rental("ZR-BBBBBBBB", "2026-02-01T00:00:00Z")]);
    expect(h.map((x) => x.reference)).toEqual(["ZR-BBBBBBBB", "ZR-AAAAAAAA"]);
    expect(h[0].receiptHref).toBe("/api/receipts/ZR-BBBBBBBB");
    expect(h[0].reportHref).toBe("/account/incident?rental=ZR-BBBBBBBB");
  });
  it("escapes LIKE wildcards in emails", () => expect(likeEscape("a_b%@x.com")).toBe("a\\_b\\%@x.com"));
});

describe("routing helpers", () => {
  it("routes roles to their home", () => {
    expect(homeFor("customer")).toBe("/account");
    expect(homeFor("partner")).toBe("/partners");
    expect(homeFor("admin")).toBe("/admin");
    expect(homeFor(null)).toBe("/");
    expect(consoleFor("customer")).toBeNull();
    expect(consoleFor("staff")?.href).toBe("/admin");
  });
  it("incident categories and safe redirects", () => {
    expect(incidentCategory("damaged")).toBe("Damaged charger");
    expect(incidentCategory("lost")).toBe("Other");
    expect(safeNext("//evil.com")).toBeNull();
    expect(safeNext("/account")).toBe("/account");
  });
  it("serves /r on the apex and routes /account to the customer subdomain", () => {
    const r = (host: string, path: string) => planRoute({ host, path, protocol: "https:", base: "zapnivo.com" });
    // Bare apex 308s to the canonical www host, which serves /r directly.
    expect(r("zapnivo.com", "/r/ST-1")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/r/ST-1" });
    expect(r("www.zapnivo.com", "/r/ST-1")).toEqual({ kind: "next" });
    expect(r("www.zapnivo.com", "/account")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/" });
    expect(r("customer.zapnivo.com", "/account")).toEqual({ kind: "next", noindex: true });
    expect(r("support.zapnivo.com", "/r/ST-1")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/r/ST-1" });
    expect(r("partners.zapnivo.com", "/account/incident")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/incident" });
  });
});
