import { describe, expect, it } from "vitest";
import {
  addDays, analyzeSeries, dayOfWeek, daysBetween, normalizeSeries, projectSeries,
  type DailyPoint,
} from "@/lib/forecast";
import {
  buildStationForecasts, dailySeries, flattenRentalRows,
} from "@/lib/forecast-data";

/** Builds a contiguous daily series from `startDay` for `n` days. */
function series(startDay: string, n: number, fn: (i: number, day: string) => number): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(startDay, i);
    out.push({ day, count: fn(i, day) });
  }
  return out;
}

describe("normalizeSeries", () => {
  it("sorts, dedupes (last wins), drops invalid days and non-finite counts", () => {
    const out = normalizeSeries([
      { day: "2026-01-03", count: 2 },
      { day: "2026-01-01", count: 5 },
      { day: "2026-01-03", count: 7 },
      { day: "not-a-day", count: 9 },
      { day: "2026-01-02", count: NaN },
      { day: "2026-01-04", count: -3 },
    ]);
    expect(out).toEqual([
      { day: "2026-01-01", count: 5 },
      { day: "2026-01-03", count: 7 },
      { day: "2026-01-04", count: 0 },
    ]);
  });
});

describe("day helpers", () => {
  it("dayOfWeek returns UTC weekday (2026-01-04 is a Sunday)", () => {
    expect(dayOfWeek("2026-01-04")).toBe(0);
    expect(dayOfWeek("2026-01-05")).toBe(1);
    expect(dayOfWeek("2026-01-11")).toBe(0);
  });
  it("addDays/daysBetween round-trip across month boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
  });
});

describe("analyzeSeries — moving averages", () => {
  it("constant series → MA7/MA30 equal the constant once windows fill", () => {
    const pts = series("2026-01-01", 40, () => 10);
    const a = analyzeSeries(pts);
    expect(a.status).toBe("ok");
    expect(a.ma7[6].value).toBe(10);   // first full 7-day window
    expect(a.ma7[0].value).toBeNull(); // window not full yet
    expect(a.ma7[39].value).toBe(10);
    expect(a.ma30[29].value).toBe(10);
    expect(a.ma30[28].value).toBeNull();
    expect(a.meanPerDay).toBe(10);
  });

  it("ramp series → MA7 at index 6 averages days 0..6", () => {
    const pts = series("2026-01-01", 30, (i) => i);
    const a = analyzeSeries(pts);
    // counts 0..6 sum to 21 → mean 3
    expect(a.ma7[6].value).toBe(3);
  });
});

describe("analyzeSeries — linear trend", () => {
  it("perfect ramp → slope 1, intercept 0, R² 1, method linear-trend", () => {
    const pts = series("2026-01-01", 30, (i) => i + 1); // 1..30
    const a = analyzeSeries(pts);
    expect(a.status).toBe("ok");
    expect(a.trend).not.toBeNull();
    expect(a.trend!.slopePerDay).toBeCloseTo(1, 5);
    expect(a.trend!.intercept).toBeCloseTo(1, 5); // counts are 1..30 → y = x + 1
    expect(a.trend!.r2).toBeCloseTo(1, 5);
    expect(a.method).toBe("linear-trend"); // 30 days < 56 → no seasonal
    expect(a.seasonal).toBeNull();
    expect(a.confidence).toBe("low"); // < 8 weeks → never medium
  });

  it("flat series → no trend (degenerate), falls back to naive-last", () => {
    const pts = series("2026-01-01", 20, () => 4);
    const a = analyzeSeries(pts);
    expect(a.trend).toBeNull();
    expect(a.method).toBe("naive-last");
    expect(a.naiveLast).toBe(4);
    expect(a.seasonalNaive).toBe(4);
  });
});

describe("analyzeSeries — seasonal indices", () => {
  it("needs ≥8 weeks: 55 days → null, 56+ days → indices present", () => {
    const short = analyzeSeries(series("2026-01-05", 55, (_, d) => (dayOfWeek(d) === 0 ? 20 : 5)));
    expect(short.seasonal).toBeNull();
    const long = analyzeSeries(series("2026-01-05", 70, (_, d) => (dayOfWeek(d) === 0 ? 20 : 5)));
    expect(long.seasonal).not.toBeNull();
    expect(long.seasonal).toHaveLength(7);
    const sunday = long.seasonal!.find((s) => s.dow === 0)!;
    const monday = long.seasonal!.find((s) => s.dow === 1)!;
    // Sundays carry ~2.8× the average day; Mondays ~0.7×
    expect(sunday.index).toBeGreaterThan(2.5);
    expect(monday.index).toBeLessThan(0.9);
    expect(sunday.samples).toBe(10);
    expect(long.method).toBe("seasonal-trend");
  });

  it("seasonal projection puts Sunday estimates above weekday estimates", () => {
    const a = analyzeSeries(series("2026-01-05", 70, (_, d) => (dayOfWeek(d) === 0 ? 20 : 5)));
    const fc = projectSeries(a, 14);
    expect(fc).toHaveLength(14);
    const sundayFc = fc.find((f) => dayOfWeek(f.day) === 0)!;
    const mondayFc = fc.find((f) => dayOfWeek(f.day) === 1)!;
    expect(sundayFc.estimate).toBeGreaterThan(mondayFc.estimate);
  });
});

describe("analyzeSeries — insufficient data honesty", () => {
  it("empty series → no_data", () => {
    const a = analyzeSeries([]);
    expect(a.status).toBe("insufficient_data");
    expect(a.reason).toBe("no_data");
    expect(projectSeries(a, 7)).toEqual([]);
  });
  it("<14 days → only_N_days, no forecast", () => {
    const a = analyzeSeries(series("2026-01-01", 10, () => 3));
    expect(a.status).toBe("insufficient_data");
    expect(a.reason).toBe("only_10_days");
    expect(a.caveat).toContain("at least 14 days");
    expect(projectSeries(a, 7)).toEqual([]);
  });
  it("all-zero window → no_rentals_in_window", () => {
    const a = analyzeSeries(series("2026-01-01", 30, () => 0));
    expect(a.status).toBe("insufficient_data");
    expect(a.reason).toBe("no_rentals_in_window");
  });
  it("NaN/garbage input cannot produce NaN outputs", () => {
    const a = analyzeSeries([
      { day: "2026-01-01", count: NaN },
      ...series("2026-01-02", 20, () => 2),
      { day: "bad", count: 5 },
    ]);
    expect(a.status).toBe("ok");
    expect(Number.isFinite(a.meanPerDay)).toBe(true);
    for (const f of projectSeries(a, 7)) {
      expect(Number.isFinite(f.estimate)).toBe(true);
      expect(Number.isFinite(f.low)).toBe(true);
      expect(Number.isFinite(f.high)).toBe(true);
    }
  });
});

describe("projectSeries — bounds and shape", () => {
  it("returns horizon points, ordered, with low ≤ estimate ≤ high and estimate ≥ 0", () => {
    // noisy series long enough for a real fit
    const pts = series("2026-01-01", 80, (i) => Math.round(8 + i * 0.05 + (i % 3) * 2));
    const a = analyzeSeries(pts);
    expect(a.status).toBe("ok");
    const fc = projectSeries(a, 30);
    expect(fc).toHaveLength(30);
    for (let i = 0; i < fc.length; i++) {
      expect(fc[i].day).toBe(addDays(a.lastDay!, i + 1));
      expect(fc[i].low).toBeLessThanOrEqual(fc[i].estimate);
      expect(fc[i].estimate).toBeLessThanOrEqual(fc[i].high);
      expect(fc[i].estimate).toBeGreaterThanOrEqual(0);
      expect(fc[i].low).toBeGreaterThanOrEqual(0);
    }
  });
  it("clamps horizon to MAX and rejects bad horizons", () => {
    const a = analyzeSeries(series("2026-01-01", 30, (i) => i + 2));
    expect(projectSeries(a, 0)).toEqual([]);
    expect(projectSeries(a, -5)).toEqual([]);
    expect(projectSeries(a, 500).length).toBeLessThanOrEqual(90);
  });
});

describe("forecast-data pure helpers", () => {
  it("flattenRentalRows unwraps kiosk + venue embeds", () => {
    const rows = flattenRentalRows([
      { started_at: "2026-01-05T10:00:00Z", kiosks: { station_id: "ZN-001", venues: { name: "Cafe", city: "St Paul" } } },
      { started_at: null, kiosks: { station_id: "ZN-002", venues: null } },
      { started_at: "2026-01-05T11:00:00Z", kiosks: null },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ station_id: "ZN-001", venue_name: "Cafe", venue_city: "St Paul" });
    expect(rows[1].station_id).toBeNull();
  });

  it("dailySeries fills zero-days between first activity and endDay", () => {
    const rows = [
      { started_at: "2026-01-01T09:00:00Z", station_id: null, venue_name: null, venue_city: null },
      { started_at: "2026-01-01T18:00:00Z", station_id: null, venue_name: null, venue_city: null },
      { started_at: "2026-01-03T09:00:00Z", station_id: null, venue_name: null, venue_city: null },
    ];
    const s = dailySeries(rows, "2026-01-03");
    expect(s).toEqual([
      { day: "2026-01-01", count: 2 },
      { day: "2026-01-02", count: 0 },
      { day: "2026-01-03", count: 1 },
    ]);
    expect(dailySeries([], "2026-01-03")).toEqual([]);
  });

  it("buildStationForecasts ranks top-N stations and analyzes each honestly", () => {
    const mkRows = (station: string | null, n: number, startDay: string) =>
      Array.from({ length: n }, (_, i) => ({
        started_at: `${addDays(startDay, i % 20)}T12:00:00Z`,
        station_id: station, venue_name: null, venue_city: null,
      }));
    const start = "2026-01-01";
    const rows = [
      ...mkRows("ZN-A", 40, start),
      ...mkRows("ZN-B", 25, start),
      ...mkRows("ZN-C", 5, start), // too little → insufficient_data
      ...mkRows(null, 3, start),   // unattributed
    ];
    const { stations } = buildStationForecasts(rows, addDays(start, 19), 7, 2);
    expect(stations.map((s) => s.stationId)).toEqual(["ZN-A", "ZN-B"]); // top-2 by volume
    expect(stations[0].analysis.total).toBeGreaterThan(stations[1].analysis.total);
    // window only spans 20 days → every station has <14? no: 20 days of series → ok status but low confidence
    expect(stations[0].analysis.status).toBe("ok");
    expect(stations[0].analysis.confidence).toBe("low");
    expect(stations[0].forecast).toHaveLength(7);
  });
});
