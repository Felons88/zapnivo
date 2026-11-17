import { describe, expect, it } from "vitest";
import { canChargeCustomers, PRICING_V1, rentalChargeCents } from "@/lib/pricing";

describe("rentalChargeCents", () => {
  it("charges first-hour price for any rental up to one hour", () => {
    expect(rentalChargeCents(1)).toBe(699);
    expect(rentalChargeCents(60)).toBe(699);
  });
  it("adds $2.99 per additional started hour", () => {
    expect(rentalChargeCents(61)).toBe(998);   // 699 + 299 for the second started hour
    expect(rentalChargeCents(120)).toBe(998);
  });
  it("charges $6.99 first hour + $2.99/additional through 24h with no artificial cap", () => {
    expect(rentalChargeCents(7 * 60)).toBe(2493);   // 699 + 6 × 299
    expect(rentalChargeCents(24 * 60)).toBe(7576);  // 699 + 23 × 299
  });
  it("returns null beyond 24h while additional-day pricing is unfinalized", () => {
    expect(rentalChargeCents(24 * 60 + 1)).toBeNull();
    expect(rentalChargeCents(72 * 60)).toBeNull();
  });
  it("computes beyond-24h charges capped by the non-return max once days are priced", () => {
    const p = { ...PRICING_V1, approved: true, additionalDayCents: 1299 };
    expect(rentalChargeCents(25 * 60, p)).toBe(4500);                // day-1 total 7576 already exceeds the 4500 max
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
