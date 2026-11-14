import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addDays, analyzeSeries, normalizeSeries, projectSeries,
  type DailyPoint, type ForecastPoint, type SeriesAnalysis,
} from "./forecast";

/**
 * Loads real rental-start counts and feeds them to the pure forecast engine.
 * Authoritative source: `rentals.started_at` (set when a rental actually starts),
 * joined to `kiosks` for the station label. analytics_daily has no rental-start
 * dimension, so rentals is the only honest source.
 */

export const FORECAST_WINDOW_DAYS = 120;
export const TOP_STATIONS = 10;
const PAGE = 1000;
const MAX_ROWS = 50_000;

export type RentalStartRow = {
  started_at: string | null;
  station_id: string | null;
  venue_name: string | null;
  venue_city: string | null;
};

type RawRental = {
  started_at: string | null;
  kiosks?: { station_id: string | null; venues?: { name: string | null; city: string | null } | { name: string | null; city: string | null }[] | null } | null;
};

/** Flattens embedded kiosk/venue rows into flat rental-start records. */
export function flattenRentalRows(raw: RawRental[]): RentalStartRow[] {
  const out: RentalStartRow[] = [];
  for (const r of raw) {
    if (!r.started_at) continue;
    const k = r.kiosks ?? null;
    const v = k?.venues;
    const venue = Array.isArray(v) ? v[0] ?? null : v ?? null;
    out.push({
      started_at: r.started_at,
      station_id: k?.station_id ?? null,
      venue_name: venue?.name ?? null,
      venue_city: venue?.city ?? null,
    });
  }
  return out;
}

const dayKey = (iso: string) => iso.slice(0, 10);

/**
 * Pure aggregation: rental rows → contiguous daily count series.
 * Fills every day from the first observed rental to `endDay` (default: today UTC)
 * with zeros so moving averages and seasonal indices see real gaps, not missing data.
 */
export function dailySeries(rows: RentalStartRow[], endDay?: string): DailyPoint[] {
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  let first: string | null = null;
  for (const r of rows) {
    if (!r.started_at) continue;
    const d = dayKey(r.started_at);
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (!first || d < first) first = d;
  }
  if (!first) return [];
  const out: DailyPoint[] = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    out.push({ day: d, count: counts.get(d) ?? 0 });
  }
  return out;
}

export type StationSeries = {
  stationId: string;
  label: string;
  series: DailyPoint[];
  analysis: SeriesAnalysis;
  forecast: ForecastPoint[];
};

/**
 * Groups rows per station, keeps the top `topN` by total starts, builds each
 * series over the same window and analyzes it. Stations with < MIN_DAYS of
 * activity still appear — their analysis reports insufficient_data honestly.
 */
export function buildStationForecasts(
  rows: RentalStartRow[],
  endDay: string,
  horizon: number,
  topN = TOP_STATIONS,
): { stations: StationSeries[]; windowStart: string | null } {
  const byStation = new Map<string, { label: string; rows: RentalStartRow[] }>();
  for (const r of rows) {
    const id = r.station_id ?? "unknown";
    const label = r.station_id
      ? [r.station_id, r.venue_name, r.venue_city].filter(Boolean).join(" · ")
      : "Unattributed kiosk";
    const cur = byStation.get(id) ?? { label, rows: [] };
    cur.rows.push(r);
    byStation.set(id, cur);
  }
  const ranked = [...byStation.entries()]
    .map(([stationId, v]) => ({ stationId, label: v.label, rows: v.rows }))
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, topN);

  const stations: StationSeries[] = ranked.map((s) => {
    const series = dailySeries(s.rows, endDay);
    const analysis = analyzeSeries(series);
    return { stationId: s.stationId, label: s.label, series, analysis, forecast: projectSeries(analysis, horizon) };
  });

  // Window start = earliest day with any activity across all rows.
  let windowStart: string | null = null;
  for (const r of rows) {
    if (!r.started_at) continue;
    const d = dayKey(r.started_at);
    if (!windowStart || d < windowStart) windowStart = d;
  }
  return { stations, windowStart };
}

export type LoadedForecastInput = {
  networkSeries: DailyPoint[];
  networkAnalysis: SeriesAnalysis;
  networkForecast: ForecastPoint[];
  stations: StationSeries[];
  windowStart: string | null;
  windowEnd: string;
  rowCount: number;
  truncated: boolean;
};

/**
 * Fetches rental starts for the trailing `days` window (bounded, paginated)
 * and runs the full network + per-station forecast. Throws on DB error so the
 * route can return an honest 500 rather than fabricated numbers.
 */
export async function loadForecastInput(
  db: SupabaseClient,
  opts: { days?: number; horizon: number; topStations?: number } = { horizon: 7 },
): Promise<LoadedForecastInput> {
  const days = Math.min(Math.max(opts.days ?? FORECAST_WINDOW_DAYS, 14), 365);
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString();
  const until = now.toISOString();
  const endDay = until.slice(0, 10);

  const raw: RawRental[] = [];
  let truncated = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from("rentals")
      .select("started_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city))")
      .not("started_at", "is", null)
      .gte("started_at", since)
      .lte("started_at", until)
      .order("started_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`rentals_fetch:${error.message}`);
    const batch = (data ?? []) as unknown as RawRental[];
    raw.push(...batch);
    if (batch.length < PAGE) break;
    if (from + PAGE >= MAX_ROWS) truncated = true;
  }

  const rows = flattenRentalRows(raw);
  const networkSeries = normalizeSeries(dailySeries(rows, endDay));
  const networkAnalysis = analyzeSeries(networkSeries);
  const networkForecast = projectSeries(networkAnalysis, opts.horizon);
  const { stations, windowStart } = buildStationForecasts(rows, endDay, opts.horizon, opts.topStations ?? TOP_STATIONS);

  return { networkSeries, networkAnalysis, networkForecast, stations, windowStart, windowEnd: endDay, rowCount: rows.length, truncated };
}
