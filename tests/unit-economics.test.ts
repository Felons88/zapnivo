import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSUMPTION_DEFS, DEFAULT_ASSUMPTIONS, assumptionsFromRows, estimatedPaybackMonths,
  kioskUnitEconomics, listAssumptionItems, loadAssumptions, venueOpportunityAnalysis,
  type AssumptionRow,
} from "@/lib/unit-economics";

/** Minimal thenable query-builder fake: every chain ends in {data,error}. */
function fakeDb(tables: Record<string, unknown[]>) {
  return {
    from: (t: string) => {
      const rows = tables[t] ?? [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "not", "gte", "lte", "order", "eq", "in"]) q[m] = () => q;
      q.range = () => Promise.resolve({ data: rows, error: null });
      q.limit = () => Promise.resolve({ data: rows, error: null });
      q.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      return q;
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date("2026-02-01T00:00:00Z"); // window 2026-01-02 → 2026-02-01 (30d)

describe("assumptionsFromRows — defaults & validation", () => {
  it("returns all defaults for empty/missing rows", () => {
    expect(assumptionsFromRows([])).toEqual(DEFAULT_ASSUMPTIONS);
    expect(assumptionsFromRows(null)).toEqual(DEFAULT_ASSUMPTIONS);
    expect(assumptionsFromRows(undefined)).toEqual(DEFAULT_ASSUMPTIONS);
  });

  it("applies valid numeric overrides and the text key", () => {
    const rows: AssumptionRow[] = [
      { key: "kiosk.hardware_cost_cents", value: 250000, label: null, unit: null, description: null, updated_at: null },
      { key: "kiosk.connectivity_cost_cents", value: "1200", label: null, unit: null, description: null, updated_at: null },
      { key: "placement.foot_traffic_index", value: "owner_estimate", label: null, unit: null, description: null, updated_at: null },
    ];
    const a = assumptionsFromRows(rows);
    expect(a.hardwareCostCents).toBe(250000);
    expect(a.connectivityCostCents).toBe(1200);
    expect(a.footTrafficIndex).toBe("owner_estimate");
    expect(a.installCostCents).toBe(0); // untouched default
  });

  it("rejects negative, NaN, infinite and wrong-type values → defaults", () => {
    const rows: AssumptionRow[] = [
      { key: "kiosk.hardware_cost_cents", value: -5, label: null, unit: null, description: null, updated_at: null },
      { key: "kiosk.install_cost_cents", value: NaN, label: null, unit: null, description: null, updated_at: null },
      { key: "kiosk.connectivity_cost_cents", value: Infinity, label: null, unit: null, description: null, updated_at: null },
      { key: "kiosk.software_alloc_cents", value: "abc", label: null, unit: null, description: null, updated_at: null },
      { key: "kiosk.bank_cost_cents", value: { bad: true }, label: null, unit: null, description: null, updated_at: null },
      { key: "placement.foot_traffic_index", value: 42, label: null, unit: null, description: null, updated_at: null },
      { key: "placement.foot_traffic_index", value: "", label: null, unit: null, description: null, updated_at: null },
    ];
    // last write wins per key in the map — foot_traffic_index ends "" → default
    const a = assumptionsFromRows(rows);
    expect(a).toEqual(DEFAULT_ASSUMPTIONS);
  });

  it("ignores unknown keys entirely", () => {
    const rows: AssumptionRow[] = [
      { key: "other.key", value: 999, label: null, unit: null, description: null, updated_at: null },
    ];
    expect(assumptionsFromRows(rows)).toEqual(DEFAULT_ASSUMPTIONS);
  });
});

describe("loadAssumptions / listAssumptionItems — honest degradation", () => {
  it("loadAssumptions returns defaults + degraded on DB error", async () => {
    const db = { from: () => { throw new Error("no table"); } } as unknown as SupabaseClient;
    const { assumptions, degraded } = await loadAssumptions(db);
    expect(degraded).toBe(true);
    expect(assumptions).toEqual(DEFAULT_ASSUMPTIONS);
  });

  it("listAssumptionItems merges DB rows over defs and flags source", async () => {
    const db = fakeDb({
      admin_finance_assumptions: [
        { key: "kiosk.hardware_cost_cents", value: 100000, label: "HW", unit: "usd_cents", description: "d", updated_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const { items, degraded } = await listAssumptionItems(db);
    expect(degraded).toBe(false);
    expect(items.length).toBe(ASSUMPTION_DEFS.length);
    const hw = items.find((i) => i.key === "kiosk.hardware_cost_cents")!;
    expect(hw.value).toBe(100000);
    expect(hw.source).toBe("db");
    const conn = items.find((i) => i.key === "kiosk.connectivity_cost_cents")!;
    expect(conn.value).toBe(0);
    expect(conn.source).toBe("default");
  });
});

describe("estimatedPaybackMonths — edge cases", () => {
  it("computes one-time ÷ positive net monthly", () => {
    expect(estimatedPaybackMonths(120000, 10000)).toBe(12);
    expect(estimatedPaybackMonths(100, 300)).toBe(0.3);
  });
  it("returns null when revenue <= costs (net monthly <= 0)", () => {
    expect(estimatedPaybackMonths(120000, 0)).toBeNull();
    expect(estimatedPaybackMonths(120000, -500)).toBeNull();
  });
  it("never returns negative, Infinity or NaN", () => {
    for (const [o, n] of [[-1, 100], [100, -1], [0, -1], [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity]] as const) {
      const r = estimatedPaybackMonths(o, n);
      expect(r === null || (Number.isFinite(r) && r >= 0)).toBe(true);
    }
  });
  it("zero one-time cost with positive net → 0 months", () => {
    expect(estimatedPaybackMonths(0, 5000)).toBe(0);
  });
});

describe("kioskUnitEconomics — observed vs assumption separation", () => {
  it("aggregates rentals/payments per kiosk and nulls payback when revenue is zero", async () => {
    const started = "2026-01-10T12:00:00Z";
    const db = fakeDb({
      admin_finance_assumptions: [
        { key: "kiosk.hardware_cost_cents", value: 100000, label: null, unit: null, description: null, updated_at: null },
        { key: "kiosk.install_cost_cents", value: 50000, label: null, unit: null, description: null, updated_at: null },
        { key: "kiosk.maintenance_cost_cents", value: 2000, label: null, unit: null, description: null, updated_at: null },
      ],
      kiosks: [
        { id: "k1", station_id: "ZN-1", venue_id: "v1", model: "m", state: "live", venues: { name: "Cafe", city: "StP", venue_type: "cafe" } },
        { id: "k2", station_id: "ZN-2", venue_id: null, model: null, state: "live", venues: null },
      ],
      rentals: [
        { id: "r1", kiosk_id: "k1", started_at: started },
        { id: "r2", kiosk_id: "k1", started_at: "2026-01-11T12:00:00Z" },
        { id: "r3", kiosk_id: "k2", started_at: "2026-01-12T12:00:00Z" },
      ],
      payments: [
        { rental_id: "r1", amount_captured_cents: 800, amount_refunded_cents: 100, captured_at: "2026-01-10T13:00:00Z", rentals: { kiosk_id: "k1" } },
        { rental_id: "r3", amount_captured_cents: 500, amount_refunded_cents: 0, captured_at: "2026-01-12T13:00:00Z", rentals: { kiosk_id: "k2" } },
      ],
    });
    const res = await kioskUnitEconomics(db, { days: 30, now: NOW });
    expect(res.unavailable).toEqual([]);
    expect(res.kiosks).toHaveLength(2);
    const k1 = res.kiosks.find((k) => k.kioskId === "k1")!;
    expect(k1.rentalCount).toBe(2);
    expect(k1.grossRevenueCents).toBe(700); // 800 − 100
    expect(k1.activeDays).toBe(2);
    expect(k1.utilizationProxy).toBeCloseTo(2 / 30, 3);
    expect(k1.avgRentalValueCents).toBe(350);
    expect(k1.monthlyOpexCents).toBe(2000); // maintenance only; others default 0
    expect(k1.oneTimeCostCents).toBe(150000); // hardware + install
    expect(k1.estimatedMonthlyGrossCents).toBe(Math.round(700 * 30 / 30));
    // net = 700 − 2000 < 0 → payback null, never negative
    expect(k1.netMonthlyContributionCents).toBe(-1300);
    expect(k1.estimatedPaybackMonths).toBeNull();
    const k2 = res.kiosks.find((k) => k.kioskId === "k2")!;
    expect(k2.grossRevenueCents).toBe(500);
    expect(k2.estimatedPaybackMonths).toBeNull(); // opex 2000 > monthly gross ~500
    expect(res.network).not.toBeNull();
    expect(res.network!.kioskCount).toBe(2);
    expect(res.network!.grossRevenueCents).toBe(1200);
    expect(res.network!.assumptionBased).toBe(true);
  });

  it("payback is positive when monthlyized revenue beats assumed opex", async () => {
    // 30 rentals × 1000¢ = 30000¢ gross in 30d → 30000/mo; opex 2000 → net 28000; one-time 84000 → 3.0 mo
    const rentals = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`, kiosk_id: "k1", started_at: `2026-01-${String((i % 28) + 2).padStart(2, "0")}T10:00:00Z`,
    }));
    const payments = rentals.map((r) => ({
      rental_id: r.id, amount_captured_cents: 1000, amount_refunded_cents: 0,
      captured_at: r.started_at, rentals: { kiosk_id: "k1" },
    }));
    const db = fakeDb({
      admin_finance_assumptions: [
        { key: "kiosk.hardware_cost_cents", value: 60000, label: null, unit: null, description: null, updated_at: null },
        { key: "kiosk.install_cost_cents", value: 24000, label: null, unit: null, description: null, updated_at: null },
        { key: "kiosk.maintenance_cost_cents", value: 2000, label: null, unit: null, description: null, updated_at: null },
      ],
      kiosks: [{ id: "k1", station_id: "ZN-1", venue_id: null, model: null, state: "live", venues: null }],
      rentals, payments,
    });
    const res = await kioskUnitEconomics(db, { days: 30, now: NOW });
    const k = res.kiosks[0];
    expect(k.grossRevenueCents).toBe(30000);
    expect(k.estimatedMonthlyGrossCents).toBe(30000);
    expect(k.netMonthlyContributionCents).toBe(28000);
    expect(k.estimatedPaybackMonths).toBe(3);
  });

  it("degrades honestly when tables are missing", async () => {
    const db = fakeDb({}); // every table empty → still works, zeros not errors
    const res = await kioskUnitEconomics(db, { days: 30, now: NOW });
    expect(res.kiosks).toEqual([]);
    expect(res.network).toBeNull();
    const opp = await venueOpportunityAnalysis(db, { days: 30, now: NOW });
    expect(opp.networkAvgRentalsPerDay).toBeNull();
    expect(opp.venues).toEqual([]);
  });
});

describe("venueOpportunityAnalysis — scenarios & insufficient data", () => {
  const baseTables = () => ({
    admin_finance_assumptions: [] as unknown[],
    venues: [
      { id: "v1", name: "Cafe", city: "StP", venue_type: "cafe", organization_id: "o1", published: true },
      { id: "v2", name: "Bar", city: "Mpls", venue_type: "bar", organization_id: "o2", published: false },
    ],
    kiosks: [
      { id: "k1", venue_id: "v1" },
      { id: "k2", venue_id: "v2" },
    ],
    partner_agreements: [
      { venue_id: "v1", organization_id: "o1", terms: { commission_pct: 20 } },
      { venue_id: null, organization_id: "o2", terms: { commission_pct: 30 } },
    ],
    partner_applications: [
      { id: "a1", business_name: "Gym", city: "Duluth", venue_type: "gym", status: "new", created_at: "2026-01-15T00:00:00Z" },
    ],
    // 60 rentals at k1 over the 30d window → 2/day network avg
    rentals: Array.from({ length: 60 }, (_, i) => ({
      kiosk_id: i % 2 === 0 ? "k1" : "k2",
      started_at: `2026-01-${String((i % 28) + 2).padStart(2, "0")}T10:00:00Z`,
      kiosks: { venue_id: i % 2 === 0 ? "v1" : "v2" },
    })),
    payments: Array.from({ length: 60 }, (_, i) => ({
      rental_id: `r${i}`,
      amount_captured_cents: 500,
      amount_refunded_cents: 0,
      captured_at: `2026-01-${String((i % 28) + 2).padStart(2, "0")}T11:00:00Z`,
      rentals: { kiosk_id: i % 2 === 0 ? "k1" : "k2" },
    })),
  });

  it("computes observed stats + labelled scenario estimates for venues", async () => {
    const res = await venueOpportunityAnalysis(fakeDb(baseTables()), { days: 30, now: NOW });
    expect(res.unavailable).toEqual([]);
    expect(res.networkAvgRentalsPerDay).toBe(2);
    expect(res.networkAvgTicketCents).toBe(500);
    expect(res.networkAvgCommissionPct).toBe(25); // mean of 20 & 30

    const v1 = res.venues.find((v) => v.id === "v1")!;
    expect(v1.observedRentals).toBe(30);
    expect(v1.observedRentalsPerDay).toBe(1);
    expect(v1.grossRevenueCents).toBe(15000);
    expect(v1.commissionPct).toBe(20);
    expect(v1.commissionSource).toBe("agreement");
    expect(v1.scenarioStatus).toBe("estimate");
    // 2/day × 30d × 500¢ = 30000 gross; net = 30000 × 0.8 = 24000
    expect(v1.scenarioGrossCents).toBe(30000);
    expect(v1.scenarioNetCents).toBe(24000);
    expect(v1.scenarioNote).toContain("Estimate only");

    const v2 = res.venues.find((v) => v.id === "v2")!;
    expect(v2.commissionPct).toBe(30); // org-level agreement fallback
    expect(v2.commissionSource).toBe("agreement");
    expect(v2.scenarioNetCents).toBe(21000); // 30000 × 0.7
  });

  it("prospective applications always get insufficient_data — never invented numbers", async () => {
    const res = await venueOpportunityAnalysis(fakeDb(baseTables()), { days: 30, now: NOW });
    expect(res.applications).toHaveLength(1);
    const a = res.applications[0];
    expect(a.kind).toBe("application");
    expect(a.scenarioStatus).toBe("insufficient_data");
    expect(a.scenarioGrossCents).toBeNull();
    expect(a.scenarioNetCents).toBeNull();
    expect(a.scenarioRentalsPerDay).toBeNull();
    expect(a.observedRentals).toBe(0);
    expect(a.scenarioNote).toContain("withheld");
  });

  it("venues get insufficient_data when the network has no history", async () => {
    const tables = baseTables();
    tables.rentals = [];
    tables.payments = [];
    const res = await venueOpportunityAnalysis(fakeDb(tables), { days: 30, now: NOW });
    expect(res.networkAvgRentalsPerDay).toBeNull();
    for (const v of res.venues) {
      expect(v.scenarioStatus).toBe("insufficient_data");
      expect(v.scenarioNetCents).toBeNull();
    }
    // commission still resolves from agreements — that's observed config, not invented
    expect(res.venues.find((v) => v.id === "v1")!.commissionPct).toBe(20);
  });
});
