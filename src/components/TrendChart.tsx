"use client";

import { useState } from "react";

/**
 * TrendChart — a responsive, accessible column chart for the ops dashboard.
 * Follows the internal dataviz rules: hairline solid gridlines, ≤24px bars with a
 * 4px rounded data-end and square baseline, a 2px surface gap between adjacent bars,
 * a legend for ≥2 series, selective direct labels (the max of each series, never a
 * number on every point), ink text (never the series color), a hover + focus tooltip,
 * and a table-view twin so no value is gated behind color or hover.
 */

export type TrendSeries = { label: string; color: string; data: number[] };

const INK = "#11122b";
const MUTED = "#61736c";
const GRID = "#e5e8e7";

const W = 720;
const H = 280;
const PAD = { l: 40, r: 10, t: 22, b: 28 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

const fmt = (v: number) => v.toLocaleString("en-US");

function niceMax(v: number) {
  if (v <= 0) return 4;
  return Math.max(4, Math.ceil(v / 4) * 4);
}

/** Square at the baseline, 4px rounded at the data end. */
function barPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export default function TrendChart({
  title,
  subtitle,
  days,
  series,
  dark = false,
}: {
  title: string;
  subtitle?: string;
  days: string[];
  series: TrendSeries[];
  dark?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const card = dark ? "border-white/10 bg-[#0f1c22] text-white" : "border-[#dfe6df] bg-white";
  const heading = dark ? "text-white" : "text-ink";
  const sub = dark ? "text-[#8fa6a8]" : "text-graphite";
  const grid = dark ? "#20323a" : GRID;
  const muted = dark ? "#7d9597" : MUTED;
  const tableHead = dark ? "bg-[#16282f] text-[#8fa6a8]" : "bg-[#f0f4ef] text-graphite";
  const tableRow = dark ? "border-white/10" : "border-mist/70";

  const n = days.length;
  const maxV = niceMax(Math.max(1, ...series.flatMap((s) => s.data)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * maxV));
  const groupW = n > 0 ? PLOT_W / n : PLOT_W;
  const barW = Math.max(4, Math.min(24, (groupW - 6) / series.length));
  const labelEvery = Math.max(1, Math.ceil(n / 7));

  const totals = days.map((_, i) => series.reduce((s, cur) => s + (cur.data[i] ?? 0), 0));

  return (
    <section aria-label={title} className={`rounded-xl border px-4 py-3 ${card}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className={`text-sm font-extrabold uppercase tracking-wider ${heading}`}>{title}</h2>
          {subtitle ? <p className={`mt-0.5 text-xs ${sub}`}>{subtitle}</p> : null}
        </div>
        {series.length > 1 ? (
          <ul className="flex flex-wrap items-center gap-3">
            {series.map((s) => (
              <li key={s.label} className={`flex items-center gap-1.5 text-xs font-bold ${sub}`}>
                <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        ) : (
          <span className={`text-xs font-bold ${sub}`}>{series[0]?.label}</span>
        )}
      </div>

      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`${title}: ${days.map((d, i) => `${d}, ${series.map((s) => `${s.label} ${fmt(s.data[i] ?? 0)}`).join(", ")}`).join("; ")}`}
        >
          {/* gridlines + y ticks — solid hairlines, one step off the surface */}
          {ticks.map((t) => {
            const y = PAD.t + PLOT_H * (1 - t / maxV);
            return (
              <g key={t}>
                <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke={t === 0 ? (dark ? "#39505a" : "#c3c2b7") : grid} strokeWidth={1} />
                <text x={PAD.l - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill={muted}>
                  {fmt(t)}
                </text>
              </g>
            );
          })}

          {/* columns */}
          {days.map((day, i) => {
            const gx = PAD.l + i * groupW;
            const totalBarsW = barW * series.length + 2 * (series.length - 1);
            const startX = gx + (groupW - totalBarsW) / 2;
            const dimmed = hover !== null && hover !== i;
            return (
              <g key={day}>
                {series.map((s, si) => {
                  const v = s.data[i] ?? 0;
                  const h = (v / maxV) * PLOT_H;
                  const x = startX + si * (barW + 2); // 2px surface gap between adjacent bars
                  const y = PAD.t + PLOT_H - h;
                  return (
                    <path
                      key={s.label}
                      d={barPath(x, y, barW, h, 4)}
                      fill={s.color}
                      opacity={dimmed ? 0.35 : 1}
                      className="transition-opacity"
                    />
                  );
                })}
                {i % labelEvery === 0 || i === n - 1 ? (
                  <text x={gx + groupW / 2} y={H - 8} textAnchor="middle" fontSize={10} fill={muted}>
                    {day.slice(5)}
                  </text>
                ) : null}
                {/* invisible hit target — bigger than the marks, keyboard reachable */}
                <rect
                  x={gx}
                  y={PAD.t}
                  width={groupW}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${day}: ${series.map((s) => `${s.label} ${fmt(s.data[i] ?? 0)}`).join(", ")}. Total ${fmt(totals[i])}.`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}

          {/* selective direct labels — only each series' maximum, never every point */}
          {series.map((s) => {
            let maxI = 0;
            for (let i = 1; i < n; i++) if ((s.data[i] ?? 0) > (s.data[maxI] ?? 0)) maxI = i;
            const v = s.data[maxI] ?? 0;
            if (v <= 0) return null;
            const si = series.indexOf(s);
            const gx = PAD.l + maxI * groupW;
            const totalBarsW = barW * series.length + 2 * (series.length - 1);
            const startX = gx + (groupW - totalBarsW) / 2;
            const x = startX + si * (barW + 2) + barW / 2;
            const y = PAD.t + PLOT_H * (1 - v / maxV);
            if (y < PAD.t + 9) return null; // would collide with the top gridline
            return (
              <text key={`lab-${s.label}`} x={x} y={y - 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={dark ? "#e8f0ec" : INK}>
                {fmt(v)}
              </text>
            );
          })}
        </svg>

        {hover !== null ? (
          <div
            className={`pointer-events-none absolute top-1 z-10 min-w-[120px] -translate-x-1/2 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg ${dark ? "border-white/15 bg-[#0f1c22]" : "border-mist bg-white"}`}
            style={{ left: `${((PAD.l + (hover + 0.5) * groupW) / W) * 100}%` }}
          >
            <p className={`font-bold ${heading}`}>{days[hover]}</p>
            {series.map((s) => (
              <p key={s.label} className={`mt-0.5 flex items-center gap-1.5 ${sub}`}>
                <span aria-hidden className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
                {s.label}
                <span className={`ml-auto font-bold ${heading}`}>{fmt(s.data[hover] ?? 0)}</span>
              </p>
            ))}
            <p className={`mt-0.5 border-t pt-0.5 ${sub} ${dark ? "border-white/10" : "border-mist"}`}>
              Total <span className={`font-bold ${heading}`}>{fmt(totals[hover])}</span>
            </p>
          </div>
        ) : null}
      </div>

      <details className="mt-2">
        <summary className={`cursor-pointer text-xs font-bold hover:underline ${dark ? "text-lime" : "text-forest"}`}>View as table</summary>
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="w-full text-xs">
            <thead className={`sticky top-0 text-left ${tableHead}`}>
              <tr>
                <th className="px-2 py-1 font-bold">Day</th>
                {series.map((s) => (
                  <th key={s.label} className="px-2 py-1 text-right font-bold">
                    {s.label}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} className={`border-t ${tableRow}`}>
                  <td className="px-2 py-1 font-semibold">{d}</td>
                  {series.map((s) => (
                    <td key={s.label} className="px-2 py-1 text-right tabular-nums">
                      {fmt(s.data[i] ?? 0)}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-bold tabular-nums">{fmt(totals[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}