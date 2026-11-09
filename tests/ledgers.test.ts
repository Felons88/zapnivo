import { describe, expect, it } from "vitest";
import { computeLedger, parseCommissionPct, periodBounds, previousPeriod } from "../src/lib/ledgers";

describe("commission ledgers", () => {
  it("only accepts an explicit 0–100 commission_pct from private terms", () => {
    expect(parseCommissionPct({ commission_pct: 25 })).toBe(25);
    expect(parseCommissionPct({ commission_pct: 0 })).toBe(0);
    expect(parseCommissionPct({ commission_pct: 101 })).toBeNull();
    expect(parseCommissionPct({ commission_pct: -1 })).toBeNull();
    expect(parseCommissionPct({ commission_pct: "25" })).toBeNull();
    expect(parseCommissionPct({})).toBeNull();
    expect(parseCommissionPct(null)).toBeNull();
  });

  it("computes gross net of refunds and rounds commission to the cent", () => {
    const r = computeLedger([{ captured: 699, refunded: 0 }, { captured: 1299, refunded: 300 }, { captured: null, refunded: null }], 25);
    expect(r.grossCents).toBe(699 + 999);
    expect(r.commissionCents).toBe(Math.round(1698 * 0.25));
  });

  it("never lets an over-refunded payment go negative", () => {
    expect(computeLedger([{ captured: 500, refunded: 900 }], 30)).toEqual({ grossCents: 0, commissionCents: 0 });
  });

  it("period helpers cover the whole month and roll the year", () => {
    expect(periodBounds("2026-02")).toMatchObject({ start: "2026-02-01T00:00:00.000Z", end: "2026-03-01T00:00:00.000Z", date: "2026-02-01" });
    expect(periodBounds("2026-12").end).toBe("2027-01-01T00:00:00.000Z");
    expect(previousPeriod(new Date("2026-01-15T12:00:00Z"))).toBe("2025-12");
  });
});
