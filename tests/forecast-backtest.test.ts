import { describe, expect, it } from "vitest";
import {
  addDays, analyzeSeries, backtestSeries, dayOfWeek, MIN_BACKTEST_ORIGINS,
  type DailyPoint,
} from "@/lib/forecast";

function series(startDay: string, n: number, fn: (i: number, day: string) => number): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(startDay, i);
    out.push({ day, count: fn(i, day) });
  }
  return out;
}

describe("backtestSeries — insufficient data honesty", () => {
  it("empty series → insufficient_data / not_enough_history", () => {
    const r = backtestSeries([]);
    expect(r.status).toBe("insufficient_data");
    expect(r.reason).toBe("not_enough_history");
    expect(r.reliability).toBe("insufficient_data");
    expect(r.meanMae).toBeNull();
  });

  it("series too short for any full-horizon origin → insufficient_data", () => {
    // 20 days, minTrain 14, horizon 7 → need i+7 < 20 with i ≥ 13 → none
    const r = backtestSeries(series("2026-01-01", 20, () => 5), { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("insufficient_data");
    expect(r.reason).toBe("not_enough_history");
  });

  it("fewer than MIN_BACKTEST_ORIGINS scored origins → insufficient_data with reason", () => {
    // 25 days → candidates i=13..17 → 5 origins < 8
    const r = backtestSeries(series("2026-01-01", 25, () => 5), { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("insufficient_data");
    expect(r.reason).toBe("only_5_origins");
    expect(r.origins).toHaveLength(5);
    expect(r.reliability).toBe("insufficient_data");
    expect(r.caveat).toContain("unverified");
  });
});

describe("backtestSeries — MAE math on synthetic series", () => {
  it("constant series → zero MAE for both models, tie, reliable", () => {
    const r = backtestSeries(series("2026-01-01", 60, () => 10), { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("ok");
    expect(r.origins.length).toBeGreaterThanOrEqual(MIN_BACKTEST_ORIGINS);
    expect(r.meanMae).toBe(0);
    expect(r.meanNaiveMae).toBe(0);
    expect(r.betterModel).toBe("tie"); // |0−0| within 1%
    expect(r.meanRelativeMae).toBe(0);
    expect(r.reliability).toBe("reliable"); // 0% ≤ 25%
    expect(r.byModel["naive-last"]?.origins).toBe(r.origins.length);
  });

  it("perfect linear ramp → primary model exact, naive lags, betterModel=primary", () => {
    // counts = i+1 → analyzeSeries fits y = x+1 exactly → zero forecast error
    const r = backtestSeries(series("2026-01-01", 60, (i) => i + 1), { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("ok");
    expect(r.meanMae).not.toBeNull();
    expect(r.meanMae!).toBeLessThan(0.5); // rounding only
    expect(r.meanNaiveMae!).toBeGreaterThan(2); // naive repeats last value → lags by ~4 avg
    expect(r.betterModel).toBe("primary");
    expect(r.byModel["linear-trend"]?.origins).toBeGreaterThan(0);
    // 60-day series → max train prefix is 53 days < 56 → seasonal never applies
    expect(r.seasonalOrigins).toBe(0);
  });

  it("long seasonal series → seasonal-trend model runs and is reported", () => {
    const r = backtestSeries(
      series("2026-01-05", 90, (_, d) => (dayOfWeek(d) === 0 ? 20 : 5)),
      { horizon: 7, minTrainDays: 30 },
    );
    expect(r.status).toBe("ok");
    expect(r.seasonalOrigins).toBeGreaterThan(0);
    expect(r.byModel["seasonal-trend"]?.origins).toBeGreaterThan(0);
    // seasonal model should beat naive on a strongly seasonal series
    expect(r.meanMae!).toBeLessThanOrEqual(r.meanNaiveMae! + 1e-9);
  });

  it("alternating 0/100 series → huge relative error → unreliable", () => {
    const r = backtestSeries(series("2026-01-01", 80, (i) => (i % 2 === 0 ? 100 : 0)), { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("ok");
    expect(r.meanRelativeMae!).toBeGreaterThan(0.5);
    expect(r.reliability).toBe("unreliable");
  });

  it("maxOrigins caps scored origins via striding", () => {
    const r = backtestSeries(series("2026-01-01", 200, () => 7), { horizon: 7, minTrainDays: 14, maxOrigins: 10 });
    expect(r.status).toBe("ok");
    expect(r.origins.length).toBeLessThanOrEqual(10);
  });

  it("origin days are ordered and each has full horizon actuals", () => {
    const pts = series("2026-01-01", 60, () => 3);
    const r = backtestSeries(pts, { horizon: 7, minTrainDays: 14 });
    const days = r.origins.map((o) => o.originDay);
    expect([...days].sort()).toEqual(days);
    for (const o of r.origins) {
      expect(o.trainDays).toBeGreaterThanOrEqual(14);
      expect(o.mae).toBeGreaterThanOrEqual(0);
      expect(o.naiveMae).toBeGreaterThanOrEqual(0);
      expect(o.meanActual).toBe(3);
    }
    // first scored origin: earliest i with i+1>=14 and i+7<60 → i=13 → day index 13
    expect(r.origins[0].originDay).toBe(addDays("2026-01-01", 13));
  });

  it("unsorted/duplicate input is normalized before scoring", () => {
    const shuffled = [...series("2026-01-01", 60, () => 4)].reverse();
    const r = backtestSeries(shuffled, { horizon: 7, minTrainDays: 14 });
    expect(r.status).toBe("ok");
    expect(r.meanMae).toBe(0);
  });
});
