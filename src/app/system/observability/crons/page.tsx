export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listCronRuns, listUptimeChecks, getObservabilityOverview } from "@/lib/system/observability";

export const metadata: Metadata = { title: "Observability — Crons & uptime" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default async function SystemCronsPage() {
  const db = serviceClient();
  const [overview, cronRuns, uptimeChecks] = db
    ? await Promise.all([
        getObservabilityOverview(db),
        listCronRuns(db, { limit: 200 }),
        listUptimeChecks(db, 300),
      ])
    : [null, [], []] as const;

  // Latest check per URL for the uptime table.
  const latestUp = new Map<string, (typeof uptimeChecks)[number]>();
  for (const u of uptimeChecks) if (!latestUp.has(u.url)) latestUp.set(u.url, u);

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Observability</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Scheduled jobs & uptime</h1>
          <p className="mt-1 text-sm text-slate-400">
            <code className="font-mono text-xs">cron_runs</code> records scheduler outcomes;
            <code className="font-mono text-xs"> uptime_checks</code> is fed by <code className="font-mono text-xs">/api/cron/uptime</code>
            (external GitHub Actions probe also runs independently every ~15 min).
          </p>
        </div>

        {/* Cron summary per job */}
        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <div className="border-b border-white/10 px-5 py-3">
            <h2 className="eyebrow text-slate-400">Jobs — last 24h</h2>
          </div>
          {!overview || overview.crons.jobs.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No cron runs recorded in the last 24 hours.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Job", "Last run", "Last status", "Runs 24h", "Failures 24h"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {overview.crons.jobs.map((c) => (
                  <tr key={c.job} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3 font-mono font-bold text-slate-200">{c.job}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(c.lastRunAt)}</td>
                    <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${c.lastOk ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>{c.lastOk ? "ok" : "failed"}</span></td>
                    <td className="px-4 py-3 font-mono">{c.runs24h}</td>
                    <td className={`px-4 py-3 font-mono font-bold ${c.failures24h ? "text-red-300" : "text-slate-400"}`}>{c.failures24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Recent cron run rows */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <div className="border-b border-white/10 px-5 py-3">
            <h2 className="eyebrow text-slate-400">Recent runs</h2>
          </div>
          {cronRuns.length === 0 ? (
            <p className="px-6 py-8 text-sm text-slate-400">No cron runs recorded yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-white/5 overflow-y-auto">
              {cronRuns.slice(0, 60).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-4 px-5 py-2 font-mono text-xs">
                  <span className="truncate text-slate-300">{c.job}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    {c.detail != null && <code className="max-w-[16rem] truncate text-[10px] text-slate-500">{JSON.stringify(c.detail).slice(0, 120)}</code>}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${c.ok ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>{c.ok ? "ok" : "failed"}</span>
                    <span className="text-[10px] text-slate-500">{ago(c.ran_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Uptime */}
        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <div className="border-b border-white/10 px-5 py-3">
            <h2 className="eyebrow text-slate-400">Uptime targets — latest check</h2>
          </div>
          {latestUp.size === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No uptime checks recorded yet — hit /api/cron/uptime with CRON_SECRET or wait for the external GitHub Actions probe.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Target", "Status", "HTTP", "Latency", "24h ok %", "Checked"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {[...latestUp.values()].sort((a, b) => a.url.localeCompare(b.url)).map((u) => {
                  const checks = uptimeChecks.filter((x) => x.url === u.url);
                  const okPct = checks.length ? Math.round((checks.filter((x) => x.ok).length / checks.length) * 1000) / 10 : null;
                  return (
                    <tr key={u.url} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-200">{u.url}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${u.ok ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>{u.ok ? "up" : "down"}</span></td>
                      <td className="px-4 py-3 font-mono">{u.status_code ?? "—"}</td>
                      <td className="px-4 py-3 font-mono">{u.latency_ms ?? "—"}ms</td>
                      <td className="px-4 py-3 font-mono">{okPct ?? "—"}%</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{ago(u.checked_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
