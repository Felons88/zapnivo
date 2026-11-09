import { describe, expect, it } from "vitest";
import { IdempotentKioskAdapter, NullKioskAdapter, type KioskAdapter, type DispenseResult } from "@/lib/kiosk/adapter";

describe("NullKioskAdapter (fails safe, no hardware)", () => {
  it("never reports a successful dispense", async () => {
    const r = await new NullKioskAdapter().dispense({ rentalId: "r1", stationId: "s1", idempotencyKey: "k1" });
    expect(r.status).toBe("failed");
  });
  it("reports no health data for unknown stations", async () => {
    expect(await new NullKioskAdapter().health("s1")).toBeNull();
  });
});

describe("IdempotentKioskAdapter", () => {
  it("never dispenses twice for the same idempotency key", async () => {
    let calls = 0;
    const inner: KioskAdapter = {
      health: async () => null,
      dispense: async (): Promise<DispenseResult> => { calls++; return { status: "dispensed", slot: 1, powerBankId: "pb", confirmedAt: new Date().toISOString() }; },
    };
    const a = new IdempotentKioskAdapter(inner);
    const req = { rentalId: "r1", stationId: "s1", idempotencyKey: "paid-rental-42" };
    const [r1, r2] = await Promise.all([a.dispense(req), a.dispense(req)]);
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
  });
});
