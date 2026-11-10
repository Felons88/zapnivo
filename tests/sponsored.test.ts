import { describe, expect, it } from "vitest";
import { sponsoredDiscountCents } from "@/lib/ads/sponsored";
import { PRICING_V1 } from "@/lib/pricing";
import { rentalChargeCents } from "@/lib/pricing";

describe("sponsoredDiscountCents", () => {
  it("covers charge for minutes actually used, capped by coverage", () => {
    // 30 covered minutes, rental lasted 20 → discount = charge for 20 min
    const expected = (rentalChargeCents(20, PRICING_V1) ?? 0);
    const got = sponsoredDiscountCents({ elapsedMinutes: 20, minutesCovered: 30, bankCount: 1, pricing: PRICING_V1, capCents: 99999 });
    expect(got).toBe(expected);
  });
  it("never exceeds the covered-minutes charge even for long rentals", () => {
    const capped = (rentalChargeCents(30, PRICING_V1) ?? 0);
    const got = sponsoredDiscountCents({ elapsedMinutes: 600, minutesCovered: 30, bankCount: 1, pricing: PRICING_V1, capCents: 99999 });
    expect(got).toBe(capped);
  });
  it("respects capCents (remaining net charge)", () => {
    const got = sponsoredDiscountCents({ elapsedMinutes: 30, minutesCovered: 30, bankCount: 1, pricing: PRICING_V1, capCents: 100 });
    expect(got).toBe(100);
  });
  it("zero for zero elapsed or zero coverage", () => {
    expect(sponsoredDiscountCents({ elapsedMinutes: 0, minutesCovered: 30, bankCount: 1, pricing: PRICING_V1, capCents: 9999 })).toBe(0);
    expect(sponsoredDiscountCents({ elapsedMinutes: 30, minutesCovered: 0, bankCount: 1, pricing: PRICING_V1, capCents: 9999 })).toBe(0);
  });
  it("multiplies by bank count", () => {
    const one = sponsoredDiscountCents({ elapsedMinutes: 15, minutesCovered: 30, bankCount: 1, pricing: PRICING_V1, capCents: 99999 });
    const two = sponsoredDiscountCents({ elapsedMinutes: 15, minutesCovered: 30, bankCount: 2, pricing: PRICING_V1, capCents: 99999 });
    expect(two).toBe(one * 2);
  });
});
