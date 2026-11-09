import { describe, expect, it } from "vitest";
import { canChargeCustomers, PRICING_V1, rentalChargeCents } from "@/lib/pricing";

describe("rentalChargeCents", () => {
  it("charges first-hour price for any rental up to one hour", () => {
    expect(rentalChargeCents(1)).toBe(699);
    expect(rentalChargeCents(60)).toBe(699);
  });
  it("adds per-started-hour increments", () => {
    expect(rentalChargeCents(61)).toBe(899);   // 699 + 200
    expect(rentalChargeCents(120)).toBe(899);
  });
  it("caps the first 24 hours at the daily cap", () => {
    // 7h would be 699 + 6*200 = 1899 → capped at 1299
    expect(rentalChargeCents(7 * 60)).toBe(1299);
    expect(rentalChargeCents(24 * 60)).toBe(1299);
  });
  it("returns null beyond 24h while additional-day pricing is unfinalized", () => {
    expect(rentalChargeCents(24 * 60 + 1)).toBeNull();
    expect(rentalChargeCents(72 * 60)).toBeNull();
  });
  it("computes beyond-24h charges capped by the non-return max once days are priced", () => {
    const p = { ...PRICING_V1, approved: true, additionalDayCents: 1299 };
    expect(rentalChargeCents(25 * 60, p)).toBe(1299 + 1299);        // day 2
    expect(rentalChargeCents(49 * 60, p)).toBe(1299 + 2 * 1299);    // day 3
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
