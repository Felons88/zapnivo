import { describe, expect, it } from "vitest";
import {
  cohortSnapshot,
  stationLeaderboard,
  weeklyCounts,
  journeyFunnel,
  weekStartOf,
  JOURNEY_FUNNEL,
  type CohortRow,
} from "@/lib/admin-insights";

const NOW = new Date("2025-02-15T12:00:00Z"); // a Saturday

describe("weekStartOf", () => {
  it("returns the Monday of the ISO week", () => {
    expect(weekStartOf("2025-02-15")).toBe("2025-02-10"); // Sat → Mon Feb 10
    expect(weekStartOf("2025-02-10")).toBe("2025-02-10");
    expect(weekStartOf("2025-02-16")).toBe("2025-02-10"); // Sun still same week
  });
});

describe("cohortSnapshot", () => {
  const row = (cohort_date: string, subject: string, last_seen: string, days_active = 3): CohortRow => ({
    cohort_date, subject, first_event: "page_view", days_active, last_seen,
  });

  it("computes week-2 and week-4 retention only over matured cohorts", () => {
    const rows = [
      // cohort 2025-01-06 (matured for both w2 and w4 as of 2025-02-15)
      row("2025-01-06", "a", "2025-02-10", 20), // retained both
      row("2025-01-06", "b", "2025-01-20", 5),  // retained w2 (≥Jan13) but not w4 (needs ≥Feb3)
      row("2025-01-06", "c", "2025-01-08", 1),  // churned immediately
      // immature cohort — not old enough for w2 yet
      row("2025-02-10", "d", "2025-02-12", 2),
    ];
    const snap = cohortSnapshot(rows, NOW);
    const jan = snap.find((s) => s.weekStart === "2025-01-06");
    const feb = snap.find((s) => s.weekStart === "2025-02-10");
    expect(jan).toBeDefined();
    expect(jan!.subjects).toBe(3);
    expect(jan!.matured2).toBe(3);
    expect(jan!.matured4).toBe(3);
    // w2: a (last_seen Feb10 ≥ Jan13) + b (Jan20 ≥ Jan13) = 2/3
    expect(jan!.week2Pct).toBeCloseTo(66.7, 1);
    // w4: only a (Feb10 ≥ Feb3) = 1/3
    expect(jan!.week4Pct).toBeCloseTo(33.3, 1);
    expect(feb!.subjects).toBe(1);
    expect(feb!.matured2).toBe(0);
    expect(feb!.week2Pct).toBeNull(); // honest: not matured → no inflated number
    expect(feb!.week4Pct).toBeNull();
  });

  it("returns an empty snapshot for empty input (honest-empty)", () => {
    expect(cohortSnapshot([], NOW)).toEqual([]);
  });

  it("groups subjects into Monday-start weeks", () => {
    const rows = [
      row("2025-01-06", "a", "2025-01-07"),
      row("2025-01-08", "b", "2025-01-09"), // same ISO week
      row("2025-01-13", "c", "2025-01-14"), // next week
    ];
    const snap = cohortSnapshot(rows, NOW);
    expect(snap).toHaveLength(2);
    expect(snap[0].subjects).toBe(2);
    expect(snap[1].subjects).toBe(1);
  });
});

describe("stationLeaderboard", () => {
  const kiosks = [
    { id: "k1", station_id: "ZN-001", venue_id: "v1" },
    { id: "k2", station_id: "ZN-002", venue_id: "v1" },
    { id: "k3", station_id: "ZN-003", venue_id: null },
  ];
  const venues = [{ id: "v1", name: "Riverside Bar" }];
  const rentals = [
    { id: "r1", kiosk_id: "k1", state: "returned", created_at: "2025-01-01T00:00:00Z" },
    { id: "r2", kiosk_id: "k1", state: "active", created_at: "2025-01-02T00:00:00Z" },
    { id: "r3", kiosk_id: "k2", state: "returned", created_at: "2025-01-03T00:00:00Z" },
    { id: "r4", kiosk_id: "k3", state: "unreturned", created_at: "2025-01-04T00:00:00Z" },
    { id: "r5", kiosk_id: null, state: "returned", created_at: "2025-01-05T00:00:00Z" },
  ];
  const payments = [
    { rental_id: "r1", state: "captured", amount_captured_cents: 1200, amount_refunded_cents: 200 },
    { rental_id: "r2", state: "authorized", amount_captured_cents: null, amount_refunded_cents: null }, // not captured → excluded
    { rental_id: "r3", state: "partially_refunded", amount_captured_cents: 800, amount_refunded_cents: 0 },
    { rental_id: "r4", state: "refunded", amount_captured_cents: 500, amount_refunded_cents: 500 }, // excluded
  ];

  it("aggregates rentals, net gross, completion and venue per station", () => {
    const rows = stationLeaderboard({ rentals, payments, kiosks, venues });
    const z1 = rows.find((r) => r.station === "ZN-001")!;
    expect(z1.rentals).toBe(2);
    expect(z1.grossCents).toBe(1000); // 1200 − 200; authorized payment excluded
    expect(z1.returned).toBe(1);
    expect(z1.completionPct).toBe(50);
    expect(z1.venue).toBe("Riverside Bar");

    const z3 = rows.find((r) => r.station === "ZN-003")!;
    expect(z3.grossCents).toBe(0); // refunded payment excluded
    expect(z3.completionPct).toBe(0);

    const unk = rows.find((r) => r.station === "unknown")!;
    expect(unk.rentals).toBe(1);
    expect(unk.venue).toBeNull();

    // sorted by gross desc
    expect(rows[0].station).toBe("ZN-001");
  });

  it("flags bottom decile only when ≥5 stations have rentals", () => {
    const few = stationLeaderboard({ rentals, payments, kiosks, venues });
    expect(few.every((r) => !r.bottomDecile)).toBe(true); // only 4 stations

    const manyKiosks = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, station_id: `ZN-${String(i).padStart(3, "0")}`, venue_id: null }));
    const manyRentals = manyKiosks.map((k, i) => ({ id: `r${i}`, kiosk_id: k.id, state: "returned", created_at: "2025-01-01T00:00:00Z" }));
    const manyPayments = manyKiosks.map((k, i) => ({
      rental_id: `r${i}`, state: "captured",
      amount_captured_cents: i === 0 ? 100 : 1000 + i, // ZN-000 is the clear lowest
      amount_refunded_cents: 0,
    }));
    const rows = stationLeaderboard({ rentals: manyRentals, payments: manyPayments, kiosks: manyKiosks, venues: [] });
    const flagged = rows.filter((r) => r.bottomDecile);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].station).toBe("ZN-000");
  });

  it("returns empty for empty input (honest-empty)", () => {
    expect(stationLeaderboard({ rentals: [], payments: [], kiosks: [], venues: [] })).toEqual([]);
  });
});

describe("weeklyCounts", () => {
  it("buckets created_at into Monday weeks, sorted", () => {
    const rows = [
      { created_at: "2025-01-08T10:00:00Z" }, // week of Jan 6
      { created_at: "2025-01-07T23:00:00Z" }, // same week
      { created_at: "2025-01-15T00:00:00Z" }, // week of Jan 13
    ];
    expect(weeklyCounts(rows)).toEqual([
      { week: "2025-01-06", count: 2 },
      { week: "2025-01-13", count: 1 },
    ]);
    expect(weeklyCounts([])).toEqual([]);
  });
});

describe("journeyFunnel", () => {
  it("computes step counts and step-over-step conversion", () => {
    const byName = new Map<string, number>([
      ["page_view", 1000],
      ["rental_qr_opened", 200],
      ["rental_checkout_started", 100],
      ["rental_started", 80],
      ["rental_completed", 70],
      ["customer_feedback_submitted", 10],
    ]);
    const f = journeyFunnel(byName);
    expect(f).toHaveLength(JOURNEY_FUNNEL.length);
    expect(f[0]).toMatchObject({ name: "page_view", count: 1000, convPct: null });
    expect(f[1]).toMatchObject({ name: "rental_qr_opened", count: 200, convPct: 20 });
    expect(f[4]).toMatchObject({ name: "rental_completed", count: 70, convPct: 87.5 });
    expect(f[5].convPct).toBeCloseTo(14.3, 1);
  });

  it("yields zero counts with null conversion on empty data", () => {
    const f = journeyFunnel(new Map());
    expect(f.every((s) => s.count === 0 && s.convPct === null)).toBe(true);
  });
});
