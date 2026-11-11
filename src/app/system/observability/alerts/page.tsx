export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getAlertsOverview } from "@/lib/system/obs-extra";

export const metadata: Metadata = { title: "Observability — Alerts & incidents" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
const sevTone = (sev: string) =>
  sev === "sev1" ? "bg-red-500/15 text-red-300 ring-red-400/30" : sev === "sev2" ? "bg-orange-400/15 text-orange-300 ring-orange-400/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30";
const statusTone = (status: string) =>
  status === "resolved" ? "bg-white/10 text-slate-300 ring-white/15" : status === "monitoring" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30";

export default async function SystemAlertsPage() {
  const db = serviceClient();
  const a = await getAlertsOverview(db);

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Observability</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Alerts & incidents</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {a.configured ? "live (incidents · uptime_checks · cron_runs)" : "backend not configured"} · windows: incidents all-time recent, uptime/cron 24h · read-only
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/observability" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Overview →</Link>
            <a href={a.policy.workflowUrl} target="_blank" rel="noreferrer" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Uptime workflow ↗</a>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card title="Open incidents"><p className={`font-mono text-3xl font-bold ${a.incidents.open ? "text-amber-300" : ""}`}>{a.incidents.open}</p><p className="mt-1 text-xs text-slate-400">of {a.incidents.recent.length} recent</p></Card>
          <Card title="Uptime 24h"><p className={`font-mono text-3xl font-bold ${a.uptime.overallOkPct24h !== null && a.uptime.overallOkPct24h < 99 ? "text-red-300" : ""}`}>{a.uptime.overallOkPct24h === null ? "—" : `${a.uptime.overallOkPct24h}%`}</p><p className="mt-1 text-xs text-slate-400">{a.uptime.targets.length} targets</p></Card>
          <Card title="Cron failures 24h"><p className={`font-mono text-3xl font-bold ${a.cron.failures24h ? "text-red-300" : ""}`}>{a.cron.failures24h}</p><p className="mt-1 text-xs text-slate-400">of {a.cron.runs24h} runs</p></Card>
          <Card title="Alert channel"><p className="font-mono text-lg font-bold leading-8">GitHub issues</p><p className="mt-1 text-xs text-slate-400">external monitor</p></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Incidents */}
          <Card title="Incidents" className="!p-0">
            <div className="px-2 pb-2">
              {a.incidents.recent.length === 0 ? (
                <p className="px-3 py-6 text-sm text-slate-400">No incidents recorded.</p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {a.incidents.recent.map((i) => (
                    <li key={i.id} className="px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="font-mono font-bold text-slate-200">{i.number}</span>
                          <span className="ml-2 text-slate-300">{i.title}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${sevTone(i.severity)}`}>{i.severity}</span>
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${statusTone(i.status)}`}>{i.status}</span>
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[10px] text-slate-500">
                        <span>detected {when(i.detected_at)} ({ago(i.detected_at)})</span>
                        {i.source && <span>source: {i.source}</span>}
                        {i.services.length > 0 && <span>services: {i.services.join(", ")}</span>}
                        {i.resolved_at && <span className="text-lime">resolved {when(i.resolved_at)}</span>}
                      </div>
                      {i.summary && <p className="mt-1 max-w-2xl truncate text-[11px] text-slate-400" title={i.summary}>{i.summary}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {/* Uptime targets */}
          <Card title="Uptime — latest per target (24h)">
            {a.uptime.targets.length === 0 ? (
              <p className="text-sm text-slate-400">No uptime_checks rows in the last 24 hours. Checks are written by the uptime probe path — if the monitor is external-only, this table stays empty.</p>
            ) : (
              <table className="w-full text-left font-mono text-xs">
                <thead><tr className="text-[10px] uppercase tracking-wider text-slate-500"><th className="pb-2 pr-3">Target</th><th className="pb-2 pr-3">Now</th><th className="pb-2 pr-3">HTTP</th><th className="pb-2 pr-3">Latency</th><th className="pb-2 pr-3">24h ok</th><th className="pb-2">Checked</th></tr></thead>
                <tbody>
                  {a.uptime.targets.map((u) => (
                    <tr key={u.url} className="border-t border-white/5">
                      <td className="max-w-[14rem] truncate py-1.5 pr-3 text-slate-300" title={u.url}>{u.url.replace("https://", "")}</td>
                      <td className={`py-1.5 pr-3 font-bold ${u.ok ? "text-lime" : "text-red-300"}`}>{u.ok ? "up" : "down"}</td>
                      <td className="py-1.5 pr-3 text-slate-400">{u.statusCode ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-slate-400">{u.latencyMs != null ? `${u.latencyMs}ms` : "—"}</td>
                      <td className="py-1.5 pr-3 text-slate-400">{u.okPct24h ?? "—"}% ({u.checks24h})</td>
                      <td className="py-1.5 text-[10px] text-slate-500">{ago(u.checkedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Cron failures */}
          <Card title={`Cron failures — last 24h (${a.cron.failures24h})`} className="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Job", "Failed at"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {a.cron.failures.map((f, i) => (
                    <tr key={i} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-2.5 font-mono font-bold text-slate-200">{f.job}</td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(f.ran_at)} ({ago(f.ran_at)})</td>
                    </tr>
                  ))}
                  {a.cron.failures.length === 0 && <tr><td colSpan={2} className="px-4 py-6 text-center text-slate-400">{a.cron.runs24h === 0 ? "No cron runs recorded in 24h." : "No cron failures in 24h."}</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">Full run history (incl. ok runs + detail) under <Link href="/system/observability/crons" className="text-lime underline">Crons & uptime</Link>.</p>
          </Card>

          {/* Alert policy */}
          <Card title="Alert policy">
            <p className="text-sm text-slate-400">{a.policy.externalMonitor}</p>
            <p className="mt-2 font-mono text-[11px] text-slate-500">{a.policy.workflowPath}</p>
            <ul className="mt-3 space-y-1.5">
              {a.policy.notes.map((n, i) => <li key={i} className="text-[11px] text-slate-400">· {n}</li>)}
            </ul>
          </Card>
        </div>
      </div>
    </SystemGate>
  );
}
