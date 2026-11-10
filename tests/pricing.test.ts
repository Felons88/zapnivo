import { describe, expect, it } from "vitest";
import { canChargeCustomers, PRICING_V1, rentalChargeCents } from "@/lib/pricing";

describe("rentalChargeCents", () => {
  it("charges first-hour price for any rental up to one hour", () => {
    expect(rentalChargeCents(1)).toBe(699);
    expect(rentalChargeCents(60)).toBe(699);
  });
  it("adds per-started-hour increments", () => {
    expect(rentalChargeCents(61)).toBe(1398);  // 699 × 2 started hours
    expect(rentalChargeCents(120)).toBe(1398);
  });
  it("charges flat $6.99 per started hour through 24h with no artificial cap", () => {
    expect(rentalChargeCents(7 * 60)).toBe(4893);
    expect(rentalChargeCents(24 * 60)).toBe(16776);
  });
  it("returns null beyond 24h while additional-day pricing is unfinalized", () => {
    expect(rentalChargeCents(24 * 60 + 1)).toBeNull();
    expect(rentalChargeCents(72 * 60)).toBeNull();
  });
  it("computes beyond-24h charges capped by the non-return max once days are priced", () => {
    const p = { ...PRICING_V1, approved: true, additionalDayCents: 1299 };
    expect(rentalChargeCents(25 * 60, p)).toBe(4500);                // day-1 flat 24×699 already exceeds the 4500 max
    expect(rentalChargeCents(49 * 60, p)).toBe(4500);                // capped at the non-return max
    expect(rentalChargeCents(96 * 60, p)).toBe(4500);               // capped at non-return max
    expect(rentalChargeCents(200 * 60, p)).toBe(4500);
  });
  it("rejects invalid durations", () => {
    expect(() => rentalChargeCents(-1)).toThrow();
    expect(() => rentalChargeCents(NaN)).toThrow();
  });
});

describe("canChargeCustomers", () => {
  it("is false until pricing is approved and days are priced", () => {
    expect(canChargeCustomers()).toBe(false);
    expect(canChargeCustomers({ ...PRICING_V1, approved: true })).toBe(false);
    expect(canChargeCustomers({ ...PRICING_V1, approved: true, additionalDayCents: 1299 })).toBe(true);
  });
});
