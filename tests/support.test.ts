import { describe, expect, it } from "vitest";
import { fmt, PRICING_V1, rentalChargeCents } from "@/lib/pricing";
import { describeRental, type RentalRow } from "@/lib/rental-lookup";
import { ARTICLES, searchArticles } from "@/lib/support-content";
import { rentalLookupSchema, ticketStatusSchema, TICKET_CATEGORIES } from "@/lib/validation";

const P = PRICING_V1;
const row = (o: Partial<RentalRow> = {}): RentalRow => ({
  reference: "ZR-1A2B3C4D", state: "returned", started_at: "2026-11-08T18:00:00Z", dispensed_at: "2026-11-08T18:00:00Z",
  returned_at: "2026-11-08T20:30:00Z", non_return_deadline: null,
  kiosks: { station_id: "ZP-001", venues: { name: "Riverside Tavern", city: "St. Cloud" } },
  payments: [{ state: "captured", amount_captured_cents: 899 }], ...o,
});

describe("help center content matches the rental terms", () => {
  const text = ARTICLES.map((a) => a.body.join(" ")).join(" ");
  it("quotes every published price from the pricing config", () => {
    for (const c of [P.firstHourCents, P.additionalHourCents, P.first24hCapCents, P.nonReturnMaxCents]) expect(text).toContain(fmt(c));
    expect(text).toContain(`${P.nonReturnAfterHours} hours`);
  });
  it("never states a price that isn't in the config", () => {
    const derived = [180, 7 * 60].map((m) => rentalChargeCents(m)!); // worked examples in the articles
    const allowed = new Set([P.firstHourCents, P.additionalHourCents, P.first24hCapCents, P.nonReturnMaxCents, ...derived].map(fmt));
    for (const m of text.match(/\$\d+(?:\.\d{2})?/g) ?? []) expect(allowed.has(m), m).toBe(true);
  });
  it("labels pricing as proposed and never publishes revenue-share terms or percentages", () => {
    expect(text.toLowerCase()).toContain("proposed pilot");
    expect(text).not.toMatch(/\d+\s?%/);
  });
  it("ticket categories referenced by articles exist in the ticket form", () => {
    for (const a of ARTICLES) if (a.ticket) expect(TICKET_CATEGORIES).toContain(a.ticket);
  });
  it("has unique ids and both audiences", () => {
    expect(new Set(ARTICLES.map((a) => a.id)).size).toBe(ARTICLES.length);
    expect(ARTICLES.some((a) => a.audience === "venue")).toBe(true);
    expect(ARTICLES.some((a) => a.audience === "renter")).toBe(true);
  });
  it("search ranks title/tag matches and respects the audience pool", () => {
    const hits = searchArticles("refund", ARTICLES.filter((a) => a.audience === "renter"));
    expect(hits[0].id).toBe("r-refund");
    expect(searchArticles("refund", ARTICLES.filter((a) => a.audience === "venue")).every((a) => a.audience === "venue")).toBe(true);
    expect(searchArticles("   ")).toEqual([]);
  });
});

describe("rental lookup schema", () => {
  const base = { email: "Pat@Example.com" };
  it("requires a reference or a date window", () => {
    expect(rentalLookupSchema.safeParse(base).success).toBe(false);
    expect(rentalLookupSchema.safeParse({ ...base, reference: "zr-1a2b3c4d" }).success).toBe(true);
    expect(rentalLookupSchema.safeParse({ ...base, from: "2026-11-08T00:00:00Z", to: "2026-11-08T23:00:00Z" }).success).toBe(true);
  });
  it("normalizes email and reference", () => {
    const r = rentalLookupSchema.parse({ ...base, reference: "zr-1a2b3c4d" });
    expect(r.email).toBe("pat@example.com");
    expect(r.reference).toBe("ZR-1A2B3C4D");
  });
  it("rejects malformed references and over-wide windows (anti-enumeration)", () => {
    expect(rentalLookupSchema.safeParse({ ...base, reference: "ZR-%" }).success).toBe(false);
    expect(rentalLookupSchema.safeParse({ ...base, from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }).success).toBe(false);
    expect(rentalLookupSchema.safeParse({ ...base, from: "2026-11-09T00:00:00Z", to: "2026-11-08T00:00:00Z" }).success).toBe(false);
  });
  it("ticket status requires a well-formed number and email", () => {
    expect(ticketStatusSchema.safeParse({ ticketNumber: "z-1001", email: "a@b.co" }).success).toBe(true);
    expect(ticketStatusSchema.safeParse({ ticketNumber: "1001", email: "a@b.co" }).success).toBe(false);
  });
});

describe("describeRental", () => {
  it("never leaks emails or internal ids", () => {
    const out = JSON.stringify(describeRental(row({ payments: [{ state: "captured", amount_captured_cents: 899 }] })));
    expect(out).not.toMatch(/@|receipt_email|station_id|ZP-001/);
  });
  it("2.5h rental charged the matching published amount is fine (no refund nudge)", () => {
    const r = describeRental(row()); // 150 min → 3 started hours → 699+400 = 1099, capped 1299
    expect(r.expectedCents).toBe(2097);
    expect(r.suggestRefund).toBe(false);
  });
  it("flags a charge above the published rate and routes to refund review", () => {
    const r = describeRental(row({ payments: [{ state: "captured", amount_captured_cents: 2499 }] }));
    expect(r.suggestRefund).toBe(true);
    expect(r.ticketCategory).toBe("Refund request");
    expect(r.tone).toBe("warn");
  });
  it("authorization-only (no dispense) is explained as a hold, not a charge", () => {
    const r = describeRental(row({ state: "authorized", dispensed_at: null, returned_at: null, payments: [{ state: "authorized", amount_captured_cents: null }] }));
    expect(r.chargedCents).toBeNull();
    expect(r.suggestRefund).toBe(false);
    expect(r.charge).toMatch(/not a charge/i);
    expect(r.ticketCategory).toBe("Charger did not dispense");
  });
  it("captured charge with no dispense suggests a refund", () => {
    const r = describeRental(row({ state: "dispense_pending", dispensed_at: null, returned_at: null }));
    expect(r.suggestRefund).toBe(true);
  });
  it("active rental quotes published rates and the non-return maximum", () => {
    const r = describeRental(row({ state: "active", returned_at: null, non_return_deadline: "2026-11-11T18:00:00Z", payments: [] }));
    expect(r.charge).toContain(fmt(P.firstHourCents));
    expect(r.explanation).toContain(fmt(P.nonReturnMaxCents));
  });
  it("charged-off rental references the non-return rules and allows a refund review", () => {
    const r = describeRental(row({ state: "charged_off", payments: [{ state: "captured", amount_captured_cents: P.nonReturnMaxCents }] }));
    expect(r.explanation).toContain(`${P.nonReturnAfterHours} hours`);
    expect(r.suggestRefund).toBe(true);
  });
});
