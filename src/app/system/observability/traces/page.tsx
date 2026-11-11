export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listTraceSpans, groupTraces } from "@/lib/system/obs-extra";

export const metadata: Metadata = { title: "Observability — Traces" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const MAX_TRACES = 25;
const MAX_SPANS_PER_TRACE = 12;

export default async function SystemTracesPage() {
  const db = serviceClient();
  const spans = db ? await listTraceSpans(db, { hours: 24, limit: 300 }) : [];
  const traces = groupTraces(spans, MAX_TRACES);

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Observability</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Trace explorer</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {db ? `live (trace_spans, trailing 24h, ≤300 rows → ${traces.length} traces)` : "backend not configured"} · instrumentation is opt-in via <code className="font-mono">traced()</code>
            </p>
          </div>
          <Link href="/system/observability" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Observability overview →</Link>
        </div>

        {traces.length === 0 ? (
          <Card title="No traces recorded">
            <p className="text-sm text-slate-400">
              No trace_spans rows in the last 24 hours. Tracing is opt-in: callers wrap work in{" "}
              <code className="font-mono text-xs">traced()</code>/<code className="font-mono text-xs">recordSpan()</code> from{" "}
              <code className="font-mono text-xs">src/lib/observability.ts</code> (e.g. the OpenRouter chat call records{" "}
              <code className="font-mono text-xs">ai.openrouter.chat</code>). Absence of spans means no instrumented calls ran — not an error.
            </p>
          </Card>
        ) : (
          traces.map((t) => (
            <Card key={t.trace_id} title={`trace ${t.trace_id.slice(0, 16)}…`} className="!p-0">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/5 px-5 py-3 font-mono text-[11px] text-slate-400">
                <span>{t.spanCount} span{t.spanCount === 1 ? "" : "s"}</span>
                <span>services: {t.services.join(", ")}</span>
                <span>work {t.totalDurationMs}ms · max {t.maxDurationMs}ms</span>
                {t.errorCount > 0 && <span className="font-bold text-red-300">{t.errorCount} error{t.errorCount === 1 ? "" : "s"}</span>}
                <span className="ml-auto">{when(t.firstAt)} → {when(t.lastAt)}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>{["Span", "Service", "Kind", "Duration", "Status", "Start"].map((h) => <th key={h} className="px-4 py-2 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {t.spans.slice(0, MAX_SPANS_PER_TRACE).map((s) => (
                      <tr key={s.id} className="border-t border-white/5">
                        <td className="px-4 py-2">
                          <div className="font-mono font-bold text-slate-200">{s.name}</div>
                          <div className="font-mono text-[9px] text-slate-500">{s.span_id.slice(0, 12)}{s.parent_span_id ? ` ← ${s.parent_span_id.slice(0, 12)}` : ""}</div>
                        </td>
                        <td className="px-4 py-2 font-mono text-slate-400">{s.service}</td>
                        <td className="px-4 py-2 font-mono text-[10px] text-slate-500">{s.kind}</td>
                        <td className="px-4 py-2 font-mono">{Math.round(s.duration_ms)}ms</td>
                        <td className="px-4 py-2">
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.status === "error" ? "bg-red-500/15 text-red-300 ring-red-400/30" : s.status === "ok" ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{s.status}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-mono text-[10px] text-slate-500">{when(s.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {t.spans.length > MAX_SPANS_PER_TRACE && (
                <p className="border-t border-white/5 px-5 py-2 font-mono text-[10px] text-slate-500">+{t.spans.length - MAX_SPANS_PER_TRACE} more span(s) in this trace (bounded view).</p>
              )}
            </Card>
          ))
        )}
        {spans.length >= 300 && (
          <p className="text-center font-mono text-[11px] text-slate-500">Result bounded at 300 spans / 24h — narrow the window via the API if needed.</p>
        )}
      </div>
    </SystemGate>
  );
}
