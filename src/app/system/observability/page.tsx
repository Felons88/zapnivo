export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getObservabilityOverview } from "@/lib/system/observability";

export const metadata: Metadata = { title: "Observability" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
const tone = (ok: boolean) => (ok ? "text-lime" : "text-red-300");

export default async function SystemObservabilityPage() {
  const db = serviceClient();
  const o = await getObservabilityOverview(db);

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Observability</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Telemetry & health</h1>
          <p className="mt-1 font-mono text-xs text-slate-400">
            data: {o.configured ? "live (error_events · app_logs · trace_spans · cron_runs · uptime_checks · incidents)" : "backend not configured"} · window: trailing 24h
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/system/observability/errors" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Errors</Link>
          <Link href="/system/observability/logs" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Logs</Link>
          <Link href="/system/observability/crons" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Crons & uptime</Link>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Card title="Errors 24h"><p className={`font-mono text-3xl font-bold ${o.errors24h.total ? "text-red-300" : ""}`}>{o.errors24h.total}</p><p className="mt-1 text-xs text-slate-400">{o.errors24h.openCriticalIssues} critical issues open</p></Card>
          <Card title="Log lines 24h"><p className="font-mono text-3xl font-bold">{o.logs24h.total}</p><p className="mt-1 text-xs text-slate-400">{o.logs24h.byService.length} services</p></Card>
          <Card title="Spans 24h"><p className="font-mono text-3xl font-bold">{o.traces24h.spans}</p><p className="mt-1 text-xs text-slate-400">instrumented calls only</p></Card>
          <Card title="Cron failures"><p className={`font-mono text-3xl font-bold ${o.crons.failures24h ? "text-red-300" : ""}`}>{o.crons.failures24h}</p><p className="mt-1 text-xs text-slate-400">of {o.crons.totalRuns24h} runs</p></Card>
          <Card title="Uptime 24h"><p className={`font-mono text-3xl font-bold ${o.uptime.overallOkPct24h !== null && o.uptime.overallOkPct24h < 99 ? "text-amber-300" : ""}`}>{o.uptime.overallOkPct24h === null ? "—" : `${o.uptime.overallOkPct24h}%`}</p><p className="mt-1 text-xs text-slate-400">{o.uptime.targets.length} targets</p></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Errors breakdown */}
          <Card title="Errors by severity / runtime">
            {o.errors24h.total === 0 ? (
              <p className="text-sm text-slate-400">No error events in the last 24 hours.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 font-mono text-xs">
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Severity</p>
                  {Object.entries(o.errors24h.bySeverity).map(([k, v]) => <p key={k} className="flex justify-between"><span className="text-slate-400">{k}</span><span className="font-bold">{v}</span></p>)}
                </div>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Runtime</p>
                  {Object.entries(o.errors24h.byRuntime).map(([k, v]) => <p key={k} className="flex justify-between"><span className="text-slate-400">{k}</span><span className="font-bold">{v}</span></p>)}
                </div>
              </div>
            )}
            <Link href="/system/observability/errors" className="mt-3 inline-block text-xs font-bold text-lime underline">Open error issues →</Link>
          </Card>

          {/* Logs breakdown */}
          <Card title="Log volume by level / service">
            {o.logs24h.total === 0 ? (
              <p className="text-sm text-slate-400">No log lines in the last 24 hours.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4 font-mono text-xs">
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Level</p>
                  {Object.entries(o.logs24h.byLevel).map(([k, v]) => <p key={k} className="flex justify-between"><span className="text-slate-400">{k}</span><span className="font-bold">{v}</span></p>)}
                </div>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Top services</p>
                  {o.logs24h.byService.slice(0, 6).map((s) => <p key={s.service} className="flex justify-between"><span className="truncate text-slate-400">{s.service}</span><span className="font-bold">{s.count}</span></p>)}
                </div>
              </div>
            )}
            <Link href="/system/observability/logs" className="mt-3 inline-block text-xs font-bold text-lime underline">Browse logs →</Link>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Latency */}
          <Card title="Latency by service (traced spans)">
            {o.traces24h.byService.length === 0 ? (
              <p className="text-sm text-slate-400">No trace spans recorded — instrumentation is opt-in via <code className="font-mono text-xs">traced()</code> in src/lib/observability.ts.</p>
            ) : (
              <table className="w-full text-left font-mono text-xs">
                <thead><tr className="text-[10px] uppercase tracking-wider text-slate-500"><th className="pb-2 pr-3">Service</th><th className="pb-2 pr-3">Avg</th><th className="pb-2 pr-3">p95</th><th className="pb-2">Errors</th></tr></thead>
                <tbody>
                  {o.traces24h.byService.map((s) => (
                    <tr key={s.service} className="border-t border-white/5">
                      <td className="py-1.5 pr-3 text-slate-300">{s.service}</td>
                      <td className="py-1.5 pr-3">{s.avgMs ?? "—"}ms</td>
                      <td className="py-1.5 pr-3">{s.p95Ms ?? "—"}ms</td>
                      <td className={`py-1.5 font-bold ${s.errors ? "text-red-300" : "text-slate-400"}`}>{s.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Crons + uptime quick view */}
          <Card title="Cron health & uptime targets">
            {o.crons.jobs.length === 0 && o.uptime.targets.length === 0 ? (
              <p className="text-sm text-slate-400">No cron runs or uptime checks recorded yet.</p>
            ) : (
              <ul className="space-y-1.5 font-mono text-xs">
                {o.crons.jobs.slice(0, 5).map((c) => (
                  <li key={c.job} className="flex items-center justify-between gap-3">
                    <span className="truncate text-slate-300">cron:{c.job}</span>
                    <span className={tone(c.lastOk)}>{c.lastOk ? "ok" : "failed"} · {c.failures24h}/{c.runs24h} fail · {when(c.lastRunAt)}</span>
                  </li>
                ))}
                {o.uptime.targets.map((u) => (
                  <li key={u.url} className="flex items-center justify-between gap-3">
                    <span className="truncate text-slate-300">{u.url.replace("https://", "")}</span>
                    <span className={tone(u.ok)}>{u.ok ? "up" : "down"} · {u.okPct24h ?? "—"}% 24h · {when(u.checkedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/system/observability/crons" className="mt-3 inline-block text-xs font-bold text-lime underline">Full cron & uptime view →</Link>
          </Card>
        </div>

        {/* Incidents */}
        <Card title="Incidents" className="!p-0">
          <div className="px-5 pb-4">
            {o.incidents.recent.length === 0 ? (
              <p className="py-4 text-sm text-slate-400">No incidents recorded.</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {o.incidents.recent.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-4 py-2.5 text-xs">
                    <div className="min-w-0">
                      <span className="font-mono font-bold text-slate-200">{i.number}</span>
                      <span className="ml-2 text-slate-300">{i.title}</span>
                      <span className="ml-2 font-mono text-[10px] text-slate-500">{i.severity}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${i.status === "resolved" ? "bg-white/10 text-slate-300 ring-white/15" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>{i.status}</span>
                      <span className="font-mono text-[10px] text-slate-500">{when(i.detected_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </SystemGate>
  );
}
