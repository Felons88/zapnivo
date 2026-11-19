export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";
import { loadForecastInput, type LoadedForecastInput } from "@/lib/forecast-data";
import { FORECAST_WINDOW_DAYS } from "@/lib/forecast-data";
import { backtestSeries, dayOfWeek } from "@/lib/forecast";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Demand forecasting", robots: { index: false, follow: false } };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ── SVG chart (server-rendered, no chart lib in this repo) ──────────────── */

function ForecastChart({ data, horizon }: { data: LoadedForecastInput; horizon: number }) {
  const hist = data.networkSeries;
  const fc = data.networkForecast;
  const W = 760, H = 220, PAD = { l: 34, r: 10, t: 10, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const all = [...hist.map((p) => p.count), ...fc.map((p) => p.high)];
  const max = Math.max(1, ...all);
  const nHist = hist.length, nFc = fc.length;
  const total = nHist + nFc;
  const x = (i: number) => PAD.l + (i / Math.max(1, total - 1)) * iw;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const bw = Math.max(1, iw / total - 1);
  const lastHistIdx = nHist - 1;

  // Forecast band polygon + estimate line.
  const bandPts = [
    ...fc.map((p, i) => `${x(lastHistIdx + 1 + i).toFixed(1)},${y(p.high).toFixed(1)}`),
    ...[...fc].reverse().map((p, i) => `${x(lastHistIdx + 1 + (fc.length - 1 - i)).toFixed(1)},${y(p.low).toFixed(1)}`),
  ].join(" ");
  const estPts = fc.map((p, i) => `${x(lastHistIdx + 1 + i).toFixed(1)},${y(p.estimate).toFixed(1)}`).join(" ");
  const gridVals = [0, Math.round(max / 2), Math.round(max)];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Rental starts history and forecast">
      {gridVals.map((g) => (
        <g key={g}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-mist" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end" fontSize="9" className="fill-graphite">{g}</text>
        </g>
      ))}
      {hist.map((p, i) => (
        <rect key={p.day} x={x(i) - bw / 2} y={y(p.count)} width={bw} height={Math.max(0, y(0) - y(p.count))} rx="1"
          className={i >= nHist - horizon ? "fill-lime/50" : "fill-forest/70"}>
          <title>{`${p.day}: ${p.count} starts`}</title>
        </rect>
      ))}
      {fc.length > 0 && <polygon points={bandPts} className="fill-lime/25" />}
      {fc.length > 0 && <polyline points={estPts} fill="none" strokeWidth="2" className="stroke-ink" strokeDasharray="4 3" />}
      <line x1={x(lastHistIdx)} x2={x(lastHistIdx)} y1={PAD.t} y2={H - PAD.b} strokeWidth="1" strokeDasharray="3 3" className="stroke-silver" />
      <text x={PAD.l} y={H - 6} fontSize="9" className="fill-graphite">{hist[0]?.day ?? ""}</text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="9" className="fill-graphite">{fc[fc.length - 1]?.day ?? hist[hist.length - 1]?.day ?? ""}</text>
      <text x={x(lastHistIdx) + 4} y={PAD.t + 10} fontSize="9" className="fill-graphite">forecast →</text>
    </svg>
  );
}

function trendArrow(slope: number | null | undefined): { arrow: string; label: string } {
  if (slope == null) return { arrow: "·", label: "n/a" };
  if (slope > 0.05) return { arrow: "↑", label: "rising" };
  if (slope < -0.05) return { arrow: "↓", label: "falling" };
  return { arrow: "→", label: "flat" };
}

export default async function ForecastingPage({ searchParams }: { searchParams: Promise<{ horizon?: string }> }) {
  const { horizon: raw } = await searchParams;
  const horizon = raw === "30" ? 30 : 7;
  const db = serviceClient();
  let data: LoadedForecastInput | null = null;
  let loadError = false;
  if (db) {
    try {
      data = await loadForecastInput(db, { horizon });
    } catch {
      loadError = true;
    }
  }
  const a = data?.networkAnalysis ?? null;
  const backtest = data ? backtestSeries(data.networkSeries, { horizon }) : null;

  return (
    <AdminGate title="Demand forecasting" nav="forecasting">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-graphite">
            Estimates from observed rental starts — model output, not a guarantee. Window: last {FORECAST_WINDOW_DAYS} days.
          </p>
          <nav className="flex gap-2 text-xs font-bold" aria-label="Forecast horizon">
            {[7, 30].map((h) => (
              <Link key={h} href={`/admin/forecasting?horizon=${h}`}
                className={`rounded-full px-4 py-1.5 ${horizon === h ? "bg-ink text-white" : "bg-white text-graphite ring-1 ring-mist"}`}>
                {h}-day forecast
              </Link>
            ))}
          </nav>
        </div>

        {!db || loadError ? (
          <Notice title="Forecast unavailable.">
            {!db ? "Backend isn't configured in this environment." : "Rental data could not be loaded — try again shortly."}
          </Notice>
        ) : data && a ? (
          <>
            {a.status === "insufficient_data" ? (
              <Notice title="Not enough history to forecast.">
                {a.reason === "no_data" ? "No rental starts recorded in the window yet." : a.reason === "no_rentals_in_window" ? "No completed rental starts in the window." : `Only ${a.days} days of data — need at least 14.`} Observed counts are shown below; projections appear once enough history accumulates.
              </Notice>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Rental starts (window)" value={a.total} />
              <Metric label="Avg / day" value={a.meanPerDay} />
              <Metric label="7-day avg (latest)" value={a.ma7.filter((m) => m.value !== null).at(-1)?.value ?? "—"} />
              <Metric label="30-day avg (latest)" value={a.ma30.filter((m) => m.value !== null).at(-1)?.value ?? "—"} />
            </div>

            <section className="rounded-2xl border border-mist bg-white p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold">Network demand — history &amp; {horizon}-day estimate</h2>
                <p className="text-xs font-bold uppercase tracking-wider text-graphite">
                  model: {a.method === "seasonal-trend" ? "seasonal index × trend" : a.method === "linear-trend" ? "linear trend" : "last-day naive"} · confidence: {a.confidence ?? "n/a"}
                </p>
              </div>
              <div className="mt-4">
                <ForecastChart data={data} horizon={horizon} />
              </div>
              <p className="mt-2 text-xs text-graphite">Shaded band = ±1 residual std-dev (heuristic, not calibrated). Dashed line = point estimate.</p>
            </section>

            {a.status === "ok" && data.networkForecast.length > 0 && (
              <section className="rounded-2xl border border-mist bg-white p-4">
                <h2 className="text-lg font-bold">{horizon}-day network forecast</h2>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                        <th className="py-2 pr-4">Date</th><th className="py-2 pr-4">Day</th>
                        <th className="py-2 pr-4 text-right">Estimate</th><th className="py-2 pr-4 text-right">Low</th><th className="py-2 text-right">High</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.networkForecast.map((f) => (
                        <tr key={f.day} className="border-b border-mist/60">
                          <td className="py-2 pr-4 font-semibold">{f.day}</td>
                          <td className="py-2 pr-4 text-graphite">{DOW[dayOfWeek(f.day)]}</td>
                          <td className="py-2 pr-4 text-right font-bold">{f.estimate}</td>
                          <td className="py-2 pr-4 text-right text-graphite">{f.low}</td>
                          <td className="py-2 text-right text-graphite">{f.high}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {a.seasonal && (
                  <p className="mt-3 text-xs text-graphite">
                    Day-of-week indices: {a.seasonal.map((s) => `${DOW[s.dow]} ×${s.index}`).join(" · ")}
                  </p>
                )}
              </section>
            )}

            <section className="rounded-2xl border border-mist bg-white p-4">
              <h2 className="text-lg font-bold">Per-station estimates</h2>
              <p className="mt-1 text-xs text-graphite">Top stations by observed starts in the window. Trend arrows are the fitted slope — direction only, not a promise.</p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                      <th className="py-2 pr-4">Station</th><th className="py-2 pr-4 text-right">Starts</th>
                      <th className="py-2 pr-4 text-right">Avg/day</th><th className="py-2 pr-4">Trend</th>
                      <th className="py-2 pr-4 text-right">Next {horizon}d est.</th><th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stations.map((s) => {
                      const t = trendArrow(s.analysis.trend?.slopePerDay);
                      const nextSum = s.forecast.length ? s.forecast.reduce((sum, f) => sum + f.estimate, 0) : null;
                      return (
                        <tr key={s.stationId} className="border-b border-mist/60">
                          <td className="py-2 pr-4 font-semibold">{s.label}</td>
                          <td className="py-2 pr-4 text-right">{s.analysis.total}</td>
                          <td className="py-2 pr-4 text-right">{s.analysis.meanPerDay}</td>
                          <td className="py-2 pr-4" title={s.analysis.trend ? `slope ${s.analysis.trend.slopePerDay.toFixed(3)}/day, R² ${s.analysis.trend.r2.toFixed(2)}` : "no trend fit"}>
                            <span aria-hidden className="mr-1">{t.arrow}</span><span className="text-graphite">{t.label}</span>
                          </td>
                          <td className="py-2 pr-4 text-right font-bold">{nextSum !== null ? Math.round(nextSum * 10) / 10 : "—"}</td>
                          <td className="py-2 text-xs text-graphite">{s.analysis.status === "ok" ? `${s.analysis.method} · ${s.analysis.confidence} confidence` : "insufficient data"}</td>
                        </tr>
                      );
                    })}
                    {data.stations.length === 0 && (
                      <tr><td colSpan={6} className="py-6 text-center text-graphite">No rental starts recorded in the window yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── Forecast validation (rolling-origin backtest) ── */}
            {backtest && (
              <section className="rounded-2xl border border-mist bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-bold">Forecast validation</h2>
                  <p className="text-xs font-bold uppercase tracking-wider text-graphite">
                    rolling-origin backtest · {horizon}-day horizon
                  </p>
                </div>
                {backtest.status === "insufficient_data" ? (
                  <div className="mt-4">
                    <Pill tone="mist">insufficient data</Pill>
                    <p className="mt-2 text-sm text-graphite">{backtest.caveat}</p>
                  </div>
                ) : (
                  <>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Metric label="Reliability verdict" value={backtest.reliability} sub={`${backtest.origins.length} scored origins`} />
                      <Metric label="Mean abs. error" value={backtest.meanMae ?? "—"} sub="rentals/day, primary model" />
                      <Metric label="Naive baseline MAE" value={backtest.meanNaiveMae ?? "—"} sub="last-day repeat" />
                      <Metric
                        label="Rel. error"
                        value={backtest.meanRelativeMae !== null ? `${(backtest.meanRelativeMae * 100).toFixed(0)}%` : "—"}
                        sub="MAE ÷ mean actual"
                      />
                    </div>
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-mist text-left text-xs uppercase tracking-wider text-graphite">
                            <th className="py-2 pr-4">Model</th>
                            <th className="py-2 pr-4 text-right">Origins</th>
                            <th className="py-2 pr-4 text-right">Mean MAE</th>
                            <th className="py-2">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(backtest.byModel).map(([model, s]) => (
                            <tr key={model} className="border-b border-mist/60">
                              <td className="py-2 pr-4 font-semibold">{model === "seasonal-trend" ? "seasonal index × trend" : model === "linear-trend" ? "linear trend" : "last-day naive"}</td>
                              <td className="py-2 pr-4 text-right">{s?.origins ?? 0}</td>
                              <td className="py-2 pr-4 text-right">{s?.meanMae ?? "—"}</td>
                              <td className="py-2 text-xs text-graphite">
                                {model === "seasonal-trend" ? `seasonal model applicable at ${backtest.seasonalOrigins} origins` : ""}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-b border-mist/60">
                            <td className="py-2 pr-4 font-semibold">naive-last baseline</td>
                            <td className="py-2 pr-4 text-right">{backtest.origins.length}</td>
                            <td className="py-2 pr-4 text-right">{backtest.meanNaiveMae ?? "—"}</td>
                            <td className="py-2 text-xs text-graphite">
                              {backtest.betterModel === "tie" ? "primary model ≈ baseline (within 1%)" : backtest.betterModel === "primary" ? "primary model beats baseline" : "baseline beats primary model"}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-3 text-xs text-graphite">{backtest.caveat}</p>
                  </>
                )}
                <p className="mt-3 rounded-xl bg-mist/50 px-4 py-3 text-xs text-graphite">
                  <b className="text-ink">Caveat:</b> backtest scores how the same model would have done on past windows of this series.
                  It is evidence about fit, not a guarantee — forecasts are statistical estimates, never guaranteed revenue.
                  Verdict thresholds: reliable ≤25% relative MAE, moderate ≤50%, unreliable above; fewer than 8 scored origins → insufficient data.
                </p>
              </section>
            )}

            <section className="rounded-2xl border border-mist bg-paper p-4 text-sm text-graphite">
              <h2 className="text-lg font-bold text-ink">How to read this</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>{a.caveat}</li>
                <li>Source: <code>rentals.started_at</code> over the last {FORECAST_WINDOW_DAYS} days{data.windowStart ? ` (earliest activity ${data.windowStart})` : ""}. No fabricated or seeded numbers.</li>
                <li>Seasonal indices require ≥8 weeks of history; otherwise the model falls back to trend or last-day naive and says so.</li>
                <li>Aggregates refresh on each page load — there is no persisted forecast table.</li>
                {data.truncated && <li className="font-bold text-ink">Warning: hit the 50k-row safety cap — counts may be truncated.</li>}
              </ul>
              <p className="mt-3 text-xs">
                Machine-readable: <code>GET /api/admin/forecast?horizon={horizon}</code>
              </p>
            </section>
          </>
        ) : null}
      </div>
    </AdminGate>
  );
}
