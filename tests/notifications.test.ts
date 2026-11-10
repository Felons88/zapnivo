import { describe, expect, it } from "vitest";
import { interpolate, SMS_SCHEDULE, DEFAULT_TEMPLATES } from "../src/lib/notifications";
import { canTransition } from "../src/lib/rental-state";
import { rentalChargeCents, PRICING_V1 } from "../src/lib/pricing";

describe("confirmed pricing rules", () => {
  it("flat $6.99 per started hour, integer cents", () => {
    expect(PRICING_V1.firstHourCents).toBe(699);
    expect(PRICING_V1.additionalHourCents).toBe(699);
    expect(PRICING_V1.nonReturnMaxCents).toBe(4500);
    expect(PRICING_V1.nonReturnAfterHours).toBe(24);
  });
  it("bills every started hour with no artificial cap", () => {
    expect(rentalChargeCents(1)).toBe(699);            // first minute = 1 started hour
    expect(rentalChargeCents(60)).toBe(699);
    expect(rentalChargeCents(61)).toBe(1398);          // second started hour
    expect(rentalChargeCents(24 * 60)).toBe(24 * 699); // full day, no cap
  });
  it("refuses to compute past 24h — unresolved business rule stays unresolved", () => {
    expect(rentalChargeCents(24 * 60 + 1)).toBeNull();
    expect(rentalChargeCents(48 * 60)).toBeNull();
  });
});

describe("rental state machine", () => {
  it("enforces legal transitions only", () => {
    expect(canTransition("active", "returned")).toBe(true);
    expect(canTransition("active", "overdue")).toBe(true);
    expect(canTransition("overdue", "non_return_fee_pending")).toBe(true);
    expect(canTransition("non_return_fee_pending", "non_return_fee_paid")).toBe(true);
    expect(canTransition("returned", "active")).toBe(false);      // can't un-return
    expect(canTransition("returned", "non_return_fee_pending")).toBe(false); // never fee after return
    expect(canTransition("closed", "active")).toBe(false);
    expect(canTransition("active", "active")).toBe(true);          // idempotent
  });
});

describe("notification engine", () => {
  it("schedule slots match the confirmed trigger times", () => {
    expect(SMS_SCHEDULE.map((s) => s.minutesAfterActivation)).toEqual([0, 60, 180, 360, 720, 1200, 1380, 1440]);
    expect(new Set(SMS_SCHEDULE.map((s) => s.kind)).size).toBe(SMS_SCHEDULE.length); // dedupe key uniqueness
    for (const s of SMS_SCHEDULE) expect(DEFAULT_TEMPLATES[s.kind]).toBeTruthy();
  });
  it("interpolates vars and strips injected braces", () => {
    expect(interpolate("Hi {ref} owe {charges}", { ref: "Z-1", charges: "$6.99" })).toBe("Hi Z-1 owe $6.99");
    expect(interpolate("{ref}", { ref: "{fee} DROP" })).toBe("fee DROP"); // braces neutralized
    expect(interpolate("{deadline}", { deadline: "—" })).toBe("—");
  });
});
