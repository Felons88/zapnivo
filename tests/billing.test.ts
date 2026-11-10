import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPromo, holdCents, proportionalTaxCents, rentalChargeCents, signReceipt, verifyReceipt } from "../src/lib/billing";
import { buildReceiptPdf } from "../src/lib/pdf";
import type { PricingVersion } from "../src/lib/pricing";
import { promoUsable } from "../src/lib/promos";
import { resetRateLimits } from "../src/lib/rate-limit";

// Test-local pricing so the tests never depend on (unapproved) real prices.
const P: PricingVersion = { id: "t", approved: true, firstHourCents: 700, additionalHourCents: 200, first24hCapCents: 1300, nonReturnMaxCents: 4500, nonReturnAfterHours: 72, additionalDayCents: null };
const T0 = new Date("2026-01-01T10:00:00Z");
const after = (min: number) => new Date(T0.getTime() + min * 60000);

describe("rental charge", () => {
  it("charges the first hour for short rentals", () => {
    expect(rentalChargeCents(T0, after(1), P)).toBe(700);
    expect(rentalChargeCents(T0, after(60), P)).toBe(700);
  });
  it("adds each started additional hour", () => {
    expect(rentalChargeCents(T0, after(61), P)).toBe(900);
    expect(rentalChargeCents(T0, after(180), P)).toBe(1100);
  });
  it("caps at the first-24h cap", () => {
    expect(rentalChargeCents(T0, after(600), P)).toBe(1300);
    expect(rentalChargeCents(T0, after(24 * 60), P)).toBe(1300);
  });
  it("refuses to auto-capture beyond 24h while additional-day pricing is unset", () => {
    expect(rentalChargeCents(T0, after(24 * 60 + 1), P)).toBeNull();
  });
  it("multiplies by bank count and validates it", () => {
    expect(rentalChargeCents(T0, after(30), P, 3)).toBe(2100);
    expect(rentalChargeCents(T0, after(24 * 60 + 5), P, 2)).toBeNull();
    expect(() => rentalChargeCents(T0, after(30), P, 4)).toThrow();
    expect(() => rentalChargeCents(T0, after(30), P, 0)).toThrow();
  });
  it("hold equals non-return maximum per bank", () => {
    expect(holdCents(P, 2)).toBe(9000);
  });
});

describe("promo and tax", () => {
  it("applies percent and amount discounts", () => {
    expect(applyPromo(1000, { percent_off: 25, amount_off_cents: null })).toEqual({ discountCents: 250, netCents: 750 });
    expect(applyPromo(1000, { percent_off: "10.00", amount_off_cents: null })).toEqual({ discountCents: 100, netCents: 900 });
    expect(applyPromo(1000, { percent_off: null, amount_off_cents: 300 })).toEqual({ discountCents: 300, netCents: 700 });
  });
  it("never goes below zero", () => {
    expect(applyPromo(500, { percent_off: null, amount_off_cents: 900 })).toEqual({ discountCents: 500, netCents: 0 });
    expect(applyPromo(500, { percent_off: 100, amount_off_cents: null }).netCents).toBe(0);
    expect(applyPromo(500, null)).toEqual({ discountCents: 0, netCents: 500 });
  });
  it("scales hold tax to the charged share and never hardcodes a rate", () => {
    expect(proportionalTaxCents(0, 4500, 1000)).toBe(0);
    expect(proportionalTaxCents(450, 4500, 1000)).toBe(100);
    expect(proportionalTaxCents(450, 4500, 9999)).toBe(450);
  });
  it("checks promo usability", () => {
    const base = { code: "X", percent_off: 10, amount_off_cents: null, active: true, starts_at: null, expires_at: null, max_redemptions: 2, redemptions: 1 };
    expect(promoUsable(base)).toBe(true);
    expect(promoUsable({ ...base, redemptions: 2 })).toBe(false);
    expect(promoUsable({ ...base, active: false })).toBe(false);
    expect(promoUsable({ ...base, expires_at: "2000-01-01T00:00:00Z" })).toBe(false);
    expect(promoUsable({ ...base, starts_at: "2999-01-01T00:00:00Z" })).toBe(false);
  });
});

describe("receipt token + pdf", () => {
  it("signs and verifies bound to reference and email", () => {
    const t = signReceipt("ZR-ABC12345", "A@b.com")!;
    expect(verifyReceipt(t, "ZR-ABC12345", "a@b.com")).toBe(true);
    expect(verifyReceipt(t, "ZR-OTHER000", "a@b.com")).toBe(false);
    expect(verifyReceipt(t, "ZR-ABC12345", "x@b.com")).toBe(false);
    expect(verifyReceipt(t + "x", "ZR-ABC12345", "a@b.com")).toBe(false);
    expect(verifyReceipt(signReceipt("ZR-ABC12345", "a@b.com", -10), "ZR-ABC12345", "a@b.com")).toBe(false);
  });
  it("produces a valid-looking PDF 1.4", () => {
    const pdf = buildReceiptPdf({ reference: "ZR-ABC12345", dateIso: "2026-01-01T10:00:00Z", venue: "Test (Bar)", station: "ZN-1", subtotalCents: 700, discountCents: 0, taxCents: 0, totalCents: 700, taxApplied: false, paymentState: "captured" });
    const s = pdf.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.endsWith("%%EOF")).toBe(true);
    expect(s).toContain("Tax: not applied");
    const xrefAt = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    expect(s.slice(xrefAt, xrefAt + 4)).toBe("xref");
  });
});

vi.setConfig({ testTimeout: 30000 });

describe("checkout 503 paths", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock("../src/lib/supabase"); resetRateLimits(); });
  const post = (body: unknown) => new Request("http://localhost/api/rentals/checkout", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
  const ok = { station_id: "ZN-TEST1", email: "a@b.com", bank_count: 1 };

  it("503 payments_unconfigured without a Stripe key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { POST } = await import("../src/app/api/rentals/checkout/route");
    const res = await POST(post(ok));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unconfigured");
  });
  it("422 on invalid input", async () => {
    const { POST } = await import("../src/app/api/rentals/checkout/route");
    expect((await POST(post({ ...ok, email: "nope" }))).status).toBe(422);
    expect((await POST(post({ ...ok, bank_count: 4 }))).status).toBe(422);
  });
  it("503 pricing_not_approved when no approved pricing row exists", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order", "limit"]) chain[k] = () => chain;
    chain.maybeSingle = async () => ({ data: null });
    vi.doMock("../src/lib/supabase", () => ({ serviceClient: () => ({ from: () => chain }), anonClient: () => null }));
    const { POST } = await import("../src/app/api/rentals/checkout/route");
    const res = await POST(post(ok));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("pricing_not_approved");
  });
});
