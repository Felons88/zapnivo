import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Server-rendered dashboard building blocks for the internal console.
 * Charts follow the internal dataviz rules: single hue per series, ink text,
 * hairline chrome, 2px surface gaps, and a table-view twin so no value is gated.
 */

const FOREST = "#252d3d";
const WARNING = "#c98500"; // status: warning (dot + label always accompany it)

/** Compact KPI tile. Every value is real data or "—"; tone colors are status, never decoration. */
export function StatTile({
  label,
  value,
  sub,
  href,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  href: string;
  tone?: "default" | "urgent" | "good";
}) {
  const border = tone === "urgent" ? "border-[#f0d7cb] bg-[#fff8f3]" : "border-[#dfe6df] bg-white";
  return (
    <Link href={href} className={`group rounded-xl border px-3 py-2 transition hover:-translate-y-px hover:shadow ${border}`}>
      <span className="flex items-center justify-between gap-2 text-[10px] font-extrabold uppercase tracking-wider text-graphite">
        {label}
        <span aria-hidden className="text-forest opacity-0 transition group-hover:opacity-100">
          ↗
        </span>
      </span>
      <span className="mt-0.5 block text-2xl font-bold leading-7 tracking-tight text-ink">{value}</span>
      {sub ? <span className="mt-0.5 block text-[11px] text-graphite">{sub}</span> : null}
    </Link>
  );
}

/** Titled white panel with an optional action link in the header. */
export function Panel({ title, action, children, className = "" }: { title: string; action?: { href: string; label: string }; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-[#dfe6df] bg-white ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-[#e3e8ee] px-4 py-2.5">
        <h2 className="text-sm font-extrabold uppercase tracking-wider text-ink">{title}</h2>
        {action ? (
          <Link href={action.href} className="text-xs font-bold text-forest hover:underline">
            {action.label} →
          </Link>
        ) : null}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Key/value rows used inside panels — label left, value right, tabular figures. */
export function Rows({ items }: { items: { label: string; value: ReactNode; href?: string; tone?: "urgent" | "good" }[] }) {
  return (
    <dl className="divide-y divide-mist/70">
      {items.map((it) => (
        <div key={it.label} className="flex items-center justify-between gap-3 py-1.5">
          <dt className="min-w-0 truncate text-sm text-graphite">
            {it.href ? (
              <Link href={it.href} className="font-semibold hover:text-forest hover:underline">
                {it.label}
              </Link>
            ) : (
              <span className="font-semibold">{it.label}</span>
            )}
          </dt>
          <dd
            className={`shrink-0 text-sm font-bold tabular-nums ${
              it.tone === "urgent" ? "text-[#b3261e]" : it.tone === "good" ? "text-[#0c6b0c]" : "text-ink"
            }`}
          >
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Horizontal bar chart for an ordered funnel. Single series (uniform hue) —
 * no legend needed; the title names what is plotted. Counts sit at the bar end in
 * ink; conversion from the previous step in muted ink beside each row.
 */
export function FunnelChart({
  title,
  subtitle,
  steps,
  dark = false,
}: {
  title: string;
  subtitle?: string;
  steps: { label: string; count: number; convPct: number | null }[];
  dark?: boolean;
}) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  const card = dark ? "border-white/10 bg-[#0f1c22]" : "border-[#dfe6df] bg-white";
  const heading = dark ? "text-white" : "text-ink";
  const sub = dark ? "text-[#8fa6a8]" : "text-graphite";
  const track = dark ? "bg-white/10" : "bg-[#eef1f5]/70";
  const bar = dark ? "#d4f76a" : FOREST;
  return (
    <section aria-label={title} className={`rounded-xl border px-4 py-3 ${card}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className={`text-sm font-extrabold uppercase tracking-wider ${heading}`}>{title}</h2>
          {subtitle ? <p className={`mt-0.5 text-xs ${sub}`}>{subtitle}</p> : null}
        </div>
      </div>
      <ol className="mt-3 space-y-1.5">
        {steps.map((s, i) => {
          const pct = max > 0 ? (s.count / max) * 100 : 0;
          return (
            <li key={s.label} className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-2">
              <span className={`truncate text-xs font-semibold ${heading}`} title={s.label}>
                {s.label}
              </span>
              <span className={`h-4 overflow-hidden rounded-sm ${track}`}>
                <span
                  className="block h-full rounded-r-[4px]"
                  style={{ width: `${Math.max(s.count > 0 ? 1.5 : 0, pct)}%`, backgroundColor: bar }}
                />
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5 text-xs">
                <span className={`font-bold tabular-nums ${heading}`}>{s.count.toLocaleString("en-US")}</span>
                <span className={sub}>
                  {s.convPct == null ? (i === 0 ? "start" : "—") : `${s.convPct}%`}
                </span>
              </span>
            </li>
          );
        })}
        {steps.every((s) => s.count === 0) ? <li className={`py-4 text-sm ${sub}`}>No events in this window yet.</li> : null}
      </ol>
      <p className={`mt-2 text-[11px] ${sub}`}>Bar = visitors at each step · % = conversion from the previous step.</p>
    </section>
  );
}

/**
 * Horizontal bar leaderboard. Single series (uniform hue); the bottom-decile tail is
 * flagged with a status dot + label (never color alone) and the value rides the bar end.
 */
export function LeaderboardChart({
  title,
  subtitle,
  rows,
  format = (v) => v.toLocaleString("en-US"),
  dark = false,
}: {
  title: string;
  subtitle?: string;
  rows: { label: string; detail?: string; value: number; flag?: string }[];
  format?: (v: number) => string;
  dark?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const card = dark ? "border-white/10 bg-[#0f1c22]" : "border-[#dfe6df] bg-white";
  const heading = dark ? "text-white" : "text-ink";
  const sub = dark ? "text-[#8fa6a8]" : "text-graphite";
  const track = dark ? "bg-white/10" : "bg-[#eef1f5]/70";
  const bar = dark ? "#4d9de0" : FOREST;
  const flag = dark ? "bg-[#3a2e08] text-[#e8c95a]" : "bg-[#fff6d6] text-[#5b4300]";
  return (
    <section aria-label={title} className={`rounded-xl border px-4 py-3 ${card}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className={`text-sm font-extrabold uppercase tracking-wider ${heading}`}>{title}</h2>
          {subtitle ? <p className={`mt-0.5 text-xs ${sub}`}>{subtitle}</p> : null}
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => {
          const pct = max > 0 ? (r.value / max) * 100 : 0;
          return (
            <li key={r.label} className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`truncate text-xs font-semibold ${heading}`} title={r.label}>
                  {r.label}
                </span>
                {r.flag ? (
                  <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-extrabold uppercase tracking-wide ${flag}`} title={r.flag}>
                    ● {r.flag}
                  </span>
                ) : null}
              </span>
              <span className={`h-4 overflow-hidden rounded-sm ${track}`}>
                <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, pct)}%`, backgroundColor: bar }} />
              </span>
              <span className={`shrink-0 text-right text-xs font-bold tabular-nums ${heading}`}>{format(r.value)}</span>
            </li>
          );
        })}
        {rows.length === 0 ? <li className={`py-4 text-sm ${sub}`}>No stations with activity in this window.</li> : null}
      </ul>
    </section>
  );
}

/** Tiny inline status dot + label — status color never travels without its label. */
export function StatusDot({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
      <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${ok == null ? "bg-silver" : ok ? "bg-[#0ca30c]" : "bg-[#c98500]"}`} />
      <span className={ok ? "text-[#0c6b0c]" : "text-graphite"}>{label}</span>
    </span>
  );
}

/** Meter — same-ramp track; fill carries severity, track is a lighter step of the ramp. */
export function Meter({ value, max, label, tone = "forest" }: { value: number; max: number; label: string; tone?: "forest" | "warning" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill = tone === "warning" ? WARNING : FOREST;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-graphite">{label}</span>
        <span className="font-bold tabular-nums text-ink">{pct}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#eef1f5]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: fill }} />
      </div>
    </div>
  );
}