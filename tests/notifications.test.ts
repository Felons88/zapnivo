import { describe, expect, it } from "vitest";
import { interpolate, pushForJob, SMS_JOB_KINDS, SMS_SCHEDULE, DEFAULT_TEMPLATES } from "../src/lib/notifications";
import { canTransition } from "../src/lib/rental-state";
import { rentalChargeCents, PRICING_V1 } from "../src/lib/pricing";

describe("confirmed pricing rules", () => {
  it("flat $6.99 per started hour, integer cents", () => {
    expect(PRICING_V1.firstHourCents).toBe(699);
    expect(PRICING_V1.additionalHourCents).toBe(299);
    expect(PRICING_V1.nonReturnMaxCents).toBe(4500);
    expect(PRICING_V1.nonReturnAfterHours).toBe(24);
  });
  it("bills every started hour with no artificial cap", () => {
    expect(rentalChargeCents(1)).toBe(699);            // first minute = 1 started hour
    expect(rentalChargeCents(60)).toBe(699);
    expect(rentalChargeCents(61)).toBe(998);           // 699 + 299: second started hour
    expect(rentalChargeCents(24 * 60)).toBe(699 + 23 * 299); // full day, no cap
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

describe("push channel — every job kind maps to a customer notification", () => {
  const vars = { ref: "ZR-T1", charges: "$13.98", deadline: "Nov 12, 3:00 PM UTC", fee: "$45.00" };
  it("activation stays silent — triggerRentalStarted already pushes directly", () => {
    expect(pushForJob("activation", vars)).toBeNull();
  });
  it("reminders carry the running total and the deadline", () => {
    for (const kind of ["reminder_1h", "reminder_3h", "reminder_6h", "reminder_12h"]) {
      const m = pushForJob(kind, vars)!;
      expect(m).toBeTruthy();
      expect(m.body).toContain("ZR-T1");
      expect(m.body).toContain("$13.98");
      expect(m.body).toContain("Nov 12");
      expect(m.data).toEqual({ type: "rental", reference: "ZR-T1" });
    }
  });
  it("deadline warnings lead with the non-return fee", () => {
    expect(pushForJob("warning_20h", vars)!.body).toContain("$45.00");
    expect(pushForJob("warning_23h", vars)!.title).toContain("1 hour");
    expect(pushForJob("deadline_24h", vars)!.title).toContain("passed");
  });
  it("transactional events stay honest — no fake success copy", () => {
    expect(pushForJob("payment_failed", vars)!.body).toContain("nothing was charged");
    expect(pushForJob("non_return_fee_charged", vars)!.body).toContain("$45.00");
    expect(pushForJob("return_failed", vars)!.body).toContain("couldn't confirm");
  });
  it("unknown kinds are ignored, never fabricated", () => {
    expect(pushForJob("nonexistent_kind", vars)).toBeNull();
  });
  it("every scheduled kind has push copy (except the direct-push activation)", () => {
    for (const s of SMS_SCHEDULE) {
      if (s.kind === "activation") continue;
      expect(pushForJob(s.kind, vars), s.kind).toBeTruthy();
    }
    expect(SMS_JOB_KINDS).toContain("payment_failed");
    expect(SMS_JOB_KINDS).toContain("non_return_fee_charged");
  });
});
