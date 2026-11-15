/**
 * Demand forecasting engine — pure statistics, no I/O, fully testable.
 *
 * HONESTY CONTRACT: every result is labeled an estimate. We never fabricate
 * confidence percentages — confidence is qualitative ("low" | "medium") and
 * derived from data coverage + fit quality. Minimum-data thresholds return
 * `status: "insufficient_data"` instead of a made-up projection.
 */

export type DailyPoint = { day: string; count: number }; // day = "YYYY-MM-DD" (UTC)

export type SeriesStatus = "ok" | "insufficient_data";
export type Confidence = "low" | "medium";

export type MovingAverage = { day: string; value: number | null }; // null until window is full

export type SeasonalIndex = { dow: number; index: number; samples: number }; // dow: 0=Sun..6=Sat

export type Trend = { slopePerDay: number; intercept: number; r2: number };

export type SeriesAnalysis = {
  status: SeriesStatus;
  reason: string | null;
  /** Number of daily observations used. */
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  total: number;
  meanPerDay: number;
  /** Trailing 7-day / 30-day means aligned to each input day (null until full window). */
  ma7: MovingAverage[];
  ma30: MovingAverage[];
  /** Day-of-week seasonal indices, or null when < 8 weeks of data. */
  seasonal: SeasonalIndex[] | null;
  /** Least-squares linear trend over day index, or null when degenerate. */
  trend: Trend | null;
  /** Std-dev of in-sample residuals for the chosen model (drives forecast bands). */
  residualStd: number | null;
  /** Naive baseline: last observed day's count. */
  naiveLast: number | null;
  /** Seasonal-naive baseline: count from the same weekday one week earlier. */
  seasonalNaive: number | null;
  /** Machine-readable model name used for projections. */
  method: "seasonal-trend" | "linear-trend" | "naive-last" | "insufficient";
  confidence: Confidence | null;
  /** Human-readable caveat shown next to every projection. */
  caveat: string;
};

export type ForecastPoint = { day: string; estimate: number; low: number; high: number };

/* ── Thresholds ──────────────────────────────────────────────────────────── */

/** Fewer distinct days than this → we refuse to forecast. */
export const MIN_DAYS = 14;
/** Seasonal indices need at least 8 full weeks of history. */
export const SEASONAL_MIN_DAYS = 56;
/** API/page horizon bounds. */
export const MAX_HORIZON_DAYS = 90;

const DAY_MS = 24 * 3600_000;

/* ── Small pure helpers ──────────────────────────────────────────────────── */

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Day-of-week for a "YYYY-MM-DD" UTC string (0 = Sunday). */
export function dayOfWeek(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Adds `n` days to a "YYYY-MM-DD" UTC string. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days between two day strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`), pb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((pb - pa) / DAY_MS);
}

/** Sort + dedupe (last write wins) + drop non-finite counts, ordered by day. */
export function normalizeSeries(points: DailyPoint[]): DailyPoint[] {
  const byDay = new Map<string, number>();
  for (const p of points) {
    if (!isDay(p.day) || !Number.isFinite(p.count)) continue;
    byDay.set(p.day, Math.max(0, p.count));
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, count]) => ({ day, count }));
}

/** Counts are integers; we keep one decimal only when the value is small. */
export function roundCount(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 10) / 10;
  return Math.abs(r) >= 10 ? Math.round(r) : r;
}

function trailingMean(values: number[], window: number): MovingAverage[] {
  const out: MovingAverage[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    const n = Math.min(i + 1, window);
    out.push({ day: "", value: n === window ? roundCount(sum / window) : null });
  }
  return out;
}

function leastSquares(xs: number[], ys: number[]): Trend | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // flat line or single distinct x → no meaningful trend
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));
  return { slopePerDay: slope, intercept, r2 };
}

/* ── Analysis ────────────────────────────────────────────────────────────── */

const INSUFFICIENT_CAVEAT =
  "Not enough history to forecast honestly — need at least 14 days of rental activity. " +
  "Shown counts are observed data only.";

export function analyzeSeries(input: DailyPoint[]): SeriesAnalysis {
  const points = normalizeSeries(input);
  const days = points.length;
  const counts = points.map((p) => p.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const firstDay = points[0]?.day ?? null;
  const lastDay = points[points.length - 1]?.day ?? null;

  const base: SeriesAnalysis = {
    status: "insufficient_data",
    reason: null,
    days, firstDay, lastDay, total,
    meanPerDay: days ? roundCount(total / days) : 0,
    ma7: [], ma30: [], seasonal: null, trend: null, residualStd: null,
    naiveLast: null, seasonalNaive: null,
    method: "insufficient", confidence: null, caveat: INSUFFICIENT_CAVEAT,
  };

  if (days === 0) return { ...base, reason: "no_data" };
  if (total === 0) return { ...base, reason: "no_rentals_in_window" };
  if (days < MIN_DAYS) return { ...base, reason: `only_${days}_days` };

  // Moving averages (aligned to input days).
  const ma7raw = trailingMean(counts, 7);
  const ma30raw = trailingMean(counts, 30);
  const ma7 = ma7raw.map((m, i) => ({ day: points[i].day, value: m.value }));
  const ma30 = ma30raw.map((m, i) => ({ day: points[i].day, value: m.value }));

  // Day-of-week seasonal indices — require ≥ 8 weeks of span AND ≥ 56 obs.
  const spanDays = daysBetween(firstDay!, lastDay!);
  let seasonal: SeasonalIndex[] | null = null;
  if (days >= SEASONAL_MIN_DAYS && spanDays >= SEASONAL_MIN_DAYS - 7) {
    const overall = total / days;
    const buckets: { sum: number; n: number }[] = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    points.forEach((p, i) => {
      const b = buckets[dayOfWeek(p.day)];
      b.sum += counts[i]; b.n += 1;
    });
    seasonal = buckets.map((b, dow) => ({
      dow,
      index: b.n > 0 && overall > 0 ? roundCount((b.sum / b.n / overall) * 100) / 100 : 1,
      samples: b.n,
    }));
  }

  // Linear trend over observation index (x = day position).
  const xs = points.map((_, i) => i);
  const trend = leastSquares(xs, counts);

  // Choose the projection model honestly:
  // seasonal-trend when we have both seasonality and a usable trend,
  // else linear-trend, else naive-last.
  const seasonalIdx = (dow: number) => seasonal?.find((s) => s.dow === dow)?.index ?? 1;

  // In-sample residuals for the chosen model → band width.
  const fitted = (i: number): number => {
    if (trend) {
      const t = trend.intercept + trend.slopePerDay * i;
      return seasonal ? t * seasonalIdx(dayOfWeek(points[i].day)) : t;
    }
    return counts[counts.length - 1];
  };
  const residuals = counts.map((c, i) => c - fitted(i));
  const meanRes = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const residualStd = roundCount(Math.sqrt(residuals.reduce((a, r) => a + (r - meanRes) ** 2, 0) / residuals.length));

  const method: SeriesAnalysis["method"] =
    seasonal && trend ? "seasonal-trend" : trend ? "linear-trend" : "naive-last";

  // Qualitative confidence: medium only with deep history AND a real fit.
  const confidence: Confidence =
    days >= SEASONAL_MIN_DAYS && trend !== null && trend.r2 >= 0.25 ? "medium" : "low";

  const caveat =
    `Estimate only — model: ${method === "seasonal-trend" ? "seasonal-naive index × linear trend" : method === "linear-trend" ? "linear trend" : "last-day naive"}. ` +
    `Based on ${days} days of observed rental starts (${firstDay} → ${lastDay}), ${total} total. ` +
    (seasonal ? "Includes day-of-week seasonality (≥8 weeks history). " : "Under 8 weeks of history — no day-of-week seasonality applied. ") +
    `Bands are ±1 residual std-dev, a heuristic — not a calibrated interval. Confidence: ${confidence}.`;

  return {
    ...base,
    status: "ok",
    reason: null,
    ma7, ma30, seasonal, trend, residualStd,
    naiveLast: counts[counts.length - 1],
    seasonalNaive: counts.length >= 8 ? counts[counts.length - 8] : null,
    method, confidence, caveat,
  };
}

/** Fitted value for a future day given an analysis (x = days after lastDay). */
function fitFuture(a: SeriesAnalysis, futureDay: string): number {
  const lastIdx = a.days - 1;
  const ahead = Math.max(0, daysBetween(a.lastDay!, futureDay));
  const x = lastIdx + ahead;
  if (a.trend) {
    const t = a.trend.intercept + a.trend.slopePerDay * x;
    const s = a.seasonal?.find((v) => v.dow === dayOfWeek(futureDay))?.index ?? 1;
    return a.method === "seasonal-trend" ? t * s : t;
  }
  return a.naiveLast ?? 0;
}

/**
 * Project `horizon` days past the last observed day.
 * Returns [] for insufficient data — callers must check `status` first.
 */
export function projectSeries(a: SeriesAnalysis, horizon: number): ForecastPoint[] {
  if (a.status !== "ok" || !a.lastDay || !Number.isFinite(horizon) || horizon <= 0) return [];
  const h = Math.min(Math.floor(horizon), MAX_HORIZON_DAYS);
  const band = a.residualStd ?? Math.max(1, a.meanPerDay * 0.5);
  const out: ForecastPoint[] = [];
  for (let i = 1; i <= h; i++) {
    const day = addDays(a.lastDay, i);
    const est = Math.max(0, fitFuture(a, day));
    out.push({
      day,
      estimate: roundCount(est),
      low: roundCount(Math.max(0, est - band)),
      high: roundCount(est + band),
    });
  }
  return out;
}

/* ── Backtesting (rolling-origin validation) ──────────────────────────────── */

/**
 * Reliability verdict thresholds (documented, not hidden):
 *  - insufficient_data : fewer than MIN_BACKTEST_ORIGINS scored origins.
 *  - reliable          : mean relative MAE ≤ 0.25 (avg error ≤ 25% of avg actual).
 *  - moderate          : mean relative MAE ≤ 0.50.
 *  - unreliable        : mean relative MAE > 0.50.
 * "Relative MAE" = mean absolute error divided by the mean of all evaluated
 * actual counts — scale-free, honest about series magnitude.
 */
export const MIN_BACKTEST_ORIGINS = 8;
export const RELIABLE_REL_MAE = 0.25;
export const MODERATE_REL_MAE = 0.5;
export const DEFAULT_BACKTEST_MAX_ORIGINS = 60;

export type BacktestOrigin = {
  /** Last training day ("YYYY-MM-DD"). */
  originDay: string;
  trainDays: number;
  /** Model analyzeSeries picked for this prefix. */
  model: SeriesAnalysis["method"];
  /** True when the seasonal-trend model was applicable for this origin. */
  seasonalApplicable: boolean;
  /** MAE of the primary model forecast vs actuals over the horizon. */
  mae: number;
  /** MAE of the naive-last baseline (repeat last training count). */
  naiveMae: number;
  /** Mean of the actual counts evaluated at this origin. */
  meanActual: number;
};

export type BacktestModelSummary = { origins: number; meanMae: number | null };

export type BacktestResult = {
  status: "ok" | "insufficient_data";
  reason: string | null;
  horizon: number;
  minTrainDays: number;
  origins: BacktestOrigin[];
  /** Mean MAE across origins (primary model). null when no origins scored. */
  meanMae: number | null;
  meanNaiveMae: number | null;
  /** meanMae / mean(actual) — scale-free error. null when degenerate. */
  meanRelativeMae: number | null;
  /** Per-model breakdown: which method ran at each origin + its mean MAE. */
  byModel: Partial<Record<SeriesAnalysis["method"], BacktestModelSummary>>;
  /** How often the seasonal-trend model was applicable across scored origins. */
  seasonalOrigins: number;
  betterModel: "primary" | "naive" | "tie" | null;
  reliability: "reliable" | "moderate" | "unreliable" | "insufficient_data";
  caveat: string;
};

export type BacktestOptions = {
  horizon?: number;
  minTrainDays?: number;
  /** Cap on scored origins — evenly strided when the series is longer. */
  maxOrigins?: number;
};

const meanAbsErr = (estimates: number[], actuals: number[]): number => {
  let s = 0;
  for (let i = 0; i < actuals.length; i++) s += Math.abs((estimates[i] ?? 0) - actuals[i]);
  return s / Math.max(1, actuals.length);
};

/**
 * Rolling-origin backtest — PURE, no I/O.
 *
 * For every origin with ≥ `minTrainDays` of history AND a full `horizon` of
 * actuals ahead, we fit analyzeSeries on the prefix, project `horizon` days,
 * and score MAE against the real counts. A naive-last baseline (repeat the
 * last observed count) is scored alongside so the fancy model must earn its
 * keep. Origins are evenly strided when there are more candidates than
 * `maxOrigins`.
 *
 * Nothing is fabricated: prefixes that analyzeSeries rejects (insufficient
 * data) are skipped, and < MIN_BACKTEST_ORIGINS scored origins →
 * status "insufficient_data".
 */
export function backtestSeries(input: DailyPoint[], opts: BacktestOptions = {}): BacktestResult {
  const horizon = Math.min(Math.max(Math.floor(opts.horizon ?? 7), 1), MAX_HORIZON_DAYS);
  const minTrainDays = Math.max(Math.floor(opts.minTrainDays ?? MIN_DAYS), MIN_DAYS);
  const maxOrigins = Math.max(Math.floor(opts.maxOrigins ?? DEFAULT_BACKTEST_MAX_ORIGINS), 1);
  const points = normalizeSeries(input);

  const base: BacktestResult = {
    status: "insufficient_data",
    reason: null,
    horizon, minTrainDays,
    origins: [],
    meanMae: null, meanNaiveMae: null, meanRelativeMae: null,
    byModel: {}, seasonalOrigins: 0, betterModel: null,
    reliability: "insufficient_data",
    caveat: "",
  };

  // Candidate origins: prefix ends at index i, needs i+1 >= minTrainDays
  // training points and points[i+1 .. i+horizon] as actuals.
  const candidates: number[] = [];
  for (let i = minTrainDays - 1; i + horizon < points.length; i++) candidates.push(i);
  if (candidates.length === 0) {
    return { ...base, reason: points.length < minTrainDays + horizon ? "not_enough_history" : "no_full_horizon" };
  }

  const stride = Math.max(1, Math.ceil(candidates.length / maxOrigins));
  const origins: BacktestOrigin[] = [];

  for (let ci = 0; ci < candidates.length; ci += stride) {
    const i = candidates[ci];
    const prefix = points.slice(0, i + 1);
    const actuals = points.slice(i + 1, i + 1 + horizon).map((p) => p.count);
    if (actuals.length !== horizon) continue;

    const a = analyzeSeries(prefix);
    if (a.status !== "ok" || a.naiveLast === null) continue; // honest skip

    const fc = projectSeries(a, horizon);
    if (fc.length !== horizon) continue;
    const estimates = fc.map((f) => f.estimate);
    const naiveEstimates = actuals.map(() => a.naiveLast!);

    origins.push({
      originDay: prefix[prefix.length - 1].day,
      trainDays: prefix.length,
      model: a.method,
      seasonalApplicable: a.method === "seasonal-trend",
      mae: meanAbsErr(estimates, actuals),
      naiveMae: meanAbsErr(naiveEstimates, actuals),
      meanActual: actuals.reduce((s, v) => s + v, 0) / actuals.length,
    });
  }

  if (origins.length < MIN_BACKTEST_ORIGINS) {
    return {
      ...base,
      reason: origins.length === 0 ? "no_scorable_origins" : `only_${origins.length}_origins`,
      origins,
      caveat:
        `Backtest needs at least ${MIN_BACKTEST_ORIGINS} rolling origins with ≥${minTrainDays} ` +
        `training days and ${horizon} days of actuals ahead — only ${origins.length} scored. ` +
        "Forecast accuracy is unverified; treat projections as rough estimates only.",
    };
  }

  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const meanMae = mean(origins.map((o) => o.mae));
  const meanNaiveMae = mean(origins.map((o) => o.naiveMae));
  const allActualsMean = mean(origins.map((o) => o.meanActual));
  const meanRelativeMae = allActualsMean > 0 ? meanMae / allActualsMean : null;

  const byModel: BacktestResult["byModel"] = {};
  for (const o of origins) {
    const cur = byModel[o.model] ?? { origins: 0, meanMae: null };
    const prev = cur.meanMae ?? 0;
    cur.origins += 1;
    cur.meanMae = (prev * (cur.origins - 1) + o.mae) / cur.origins;
    byModel[o.model] = cur;
  }
  for (const k of Object.keys(byModel) as (keyof typeof byModel)[]) {
    if (byModel[k]?.meanMae != null) byModel[k]!.meanMae = roundCount(byModel[k]!.meanMae);
  }

  // Naive wins ties within 1% — the complex model must beat the baseline.
  const betterModel: BacktestResult["betterModel"] =
    Math.abs(meanMae - meanNaiveMae) <= meanNaiveMae * 0.01 ? "tie" : meanMae < meanNaiveMae ? "primary" : "naive";

  const reliability: BacktestResult["reliability"] =
    meanRelativeMae === null ? "unreliable"
    : meanRelativeMae <= RELIABLE_REL_MAE ? "reliable"
    : meanRelativeMae <= MODERATE_REL_MAE ? "moderate"
    : "unreliable";

  return {
    ...base,
    status: "ok",
    origins,
    meanMae: roundCount(meanMae),
    meanNaiveMae: roundCount(meanNaiveMae),
    meanRelativeMae: meanRelativeMae === null ? null : roundCount(meanRelativeMae * 1000) / 1000,
    byModel,
    seasonalOrigins: origins.filter((o) => o.seasonalApplicable).length,
    betterModel,
    reliability,
    caveat:
      `Rolling-origin backtest: ${origins.length} origins, ${horizon}-day horizon, ` +
      `≥${minTrainDays} training days each. Mean absolute error ${roundCount(meanMae)} rentals/day ` +
      `vs ${roundCount(meanNaiveMae)} for a naive-last baseline` +
      (meanRelativeMae !== null ? ` (${roundCount(meanRelativeMae * 100)}% of mean actual).` : ".") +
      " In-sample fit does not guarantee future accuracy — forecasts remain statistical estimates, never guaranteed revenue.",
  };
}
