export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getSystemJobs } from "@/lib/system/jobs";
import { getCronJobDetails } from "@/lib/system/db-admin";
import { RetryButton } from "./RetryButton";
import { JobControlButton } from "./JobControl";

export const metadata: Metadata = { title: "Jobs & Workers" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

const lastOkTone = (ok: boolean | null) =>
  ok === null ? "bg-white/10 text-slate-400 ring-white/15"
  : ok ? "bg-lime/15 text-lime ring-lime/30"
  : "bg-red-500/15 text-red-300 ring-red-400/30";

export default async function JobsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canRetry = roleCan(role, "system.webhooks.retry");
  const [jobs, cronDetails] = await Promise.all([getSystemJobs(db), getCronJobDetails(db)]);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Queue / Workers</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Jobs &amp; background workers</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Live counts from the real queue tables and cron_runs. Cron jobs can be paused/resumed via the{" "}
            <code className="font-mono">jobs.paused</code> setting (step-up elevation + audit; financial jobs are
            denylisted). Queue workers and provider webhooks are not pausable here.
          </p>
        </div>

        {!jobs.configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — queue data unavailable.
          </p>
        )}

        {/* Queue cards */}
        <div className="grid gap-4 md:grid-cols-3">
          {jobs.queues.map((q) => (
            <section key={q.name} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="font-mono text-sm font-bold">{q.name}</h2>
                <span className="font-mono text-[10px] text-slate-500">{q.table}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-slate-500">{q.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {Object.entries(q.counts).map(([k, v]) => (
                  <span key={k} className="rounded bg-white/5 px-2 py-1 font-mono text-[11px] text-slate-200 ring-1 ring-white/10">{k}: {v}</span>
                ))}
              </div>
              <dl className="mt-4 space-y-1 font-mono text-[11px] text-slate-400">
                <div className="flex justify-between"><dt>pending</dt><dd className="font-bold text-slate-200">{q.pending ?? "—"}</dd></div>
                <div className="flex justify-between"><dt>oldest pending</dt><dd>{when(q.oldestPendingAt)}</dd></div>
                <div className="flex justify-between"><dt>failures (total / tracked)</dt><dd>{q.failures24h == null ? "not tracked" : q.failures24h}</dd></div>
              </dl>
            </section>
          ))}
        </div>

        {/* Cron schedule */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="eyebrow text-slate-400">Cron routes</h2>
            <p className="font-mono text-[10px] text-slate-500">schedules from vercel.json · pause/resume via jobs.paused (elevation required)</p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Route</th>
                  <th className="py-2 pr-4">Schedule (UTC)</th>
                  <th className="py-2 pr-4">Next run</th>
                  <th className="py-2 pr-4">Job</th>
                  <th className="py-2 pr-4">State</th>
                  <th className="py-2 pr-4">Last run</th>
                  <th className="py-2 pr-4">Last ok</th>
                  <th className="py-2 pr-4">Runs 24h</th>
                  <th className="py-2 pr-4">Failed 24h</th>
                  <th className="py-2 pr-4">Duration (last span)</th>
                  <th className="py-2 pr-4">Dependencies</th>
                  <th className="py-2 pr-4">Last detail</th>
                  <th className="py-2">Control</th>
                </tr>
              </thead>
              <tbody>
                {jobs.cron.map((c) => {
                  const d = cronDetails.get(c.job);
                  const detailJson = d?.lastDetail ? JSON.stringify(d.lastDetail) : null;
                  return (
                  <tr key={`${c.route}:${c.job}`} className="border-b border-white/5 align-top last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{c.route}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-400">{c.schedule}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">{when(c.nextRunAt)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{c.job}</td>
                    <td className="py-2 pr-4">
                      {c.paused ? (
                        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">paused</span>
                      ) : (
                        <span className="rounded-full bg-lime/10 px-2 py-0.5 font-mono text-[10px] font-bold text-lime/80 ring-1 ring-lime/20">scheduled</span>
                      )}
                      {c.recentActivity[0] && (
                        <div className="mt-1 max-w-[140px] truncate font-mono text-[9px] text-slate-600" title={c.recentActivity.map((a) => `${a.at} ${a.label}`).join("\n")}>
                          {c.recentActivity[0].label}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">{when(c.lastRunAt)}</td>
                    <td className="py-2 pr-4">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${lastOkTone(c.lastOk)}`}>
                        {c.lastOk === null ? (c.recordsCronRuns ? "no runs" : "n/a") : c.lastOk ? "ok" : "failed"}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{c.runs24h}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{c.failures24h}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {d?.lastDurationMs == null && c.runtimeMs == null ? <span className="text-slate-600">—</span> : `${d?.lastDurationMs ?? c.runtimeMs}ms`}
                      {d?.lastSpanStatus && d.lastSpanStatus !== "ok" && <span className="ml-1 text-red-300">({d.lastSpanStatus})</span>}
                    </td>
                    <td className="max-w-[180px] py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {c.dependencies.map((dep) => (
                          <span
                            key={dep.name}
                            title={`${dep.name}: ${dep.detail}`}
                            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${
                              dep.configured === false ? "bg-red-500/10 text-red-300/90 ring-red-400/20"
                              : dep.configured === true ? "bg-lime/10 text-lime/80 ring-lime/20"
                              : "bg-white/5 text-slate-500 ring-white/10"
                            }`}
                          >
                            {dep.name}{dep.configured === false ? " ✗" : dep.configured === true ? " ✓" : ""}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[280px] py-2 pr-4">
                      {d?.lastError ? (
                        <span className="font-mono text-[11px] text-red-300/90" title={d.lastError}>{d.lastError.slice(0, 120)}</span>
                      ) : detailJson ? (
                        <details>
                          <summary className="cursor-pointer font-mono text-[11px] text-slate-400 hover:text-lime">
                            {detailJson.length > 80 ? detailJson.slice(0, 80) + "…" : detailJson}
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] text-slate-300 ring-1 ring-white/10">
                            {JSON.stringify(d?.lastDetail, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      {canRetry ? (
                        <JobControlButton job={c.job} paused={c.paused} />
                      ) : (
                        <span className="font-mono text-[10px] text-slate-600">{c.paused ? "paused" : "—"}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            All five vercel.json cron routes record <code className="font-mono">cron_runs</code> rows (Phase 2.7+). Duration is the latest{" "}
            <code className="font-mono">cron.&lt;job&gt;</code> trace span — cron_runs has no duration column; deep-dive at{" "}
            <Link href="/system/infrastructure/jobs" className="text-lime underline">/system/infrastructure/jobs</Link>.
          </p>
        </section>

        {/* Failed outbox emails */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Failed email outbox</h2>
          <p className="mt-1 text-xs text-slate-400">
            Retry requeues the row (failed → queued); the next mailer flush sends it. Recipient addresses are not shown.
            Requires <code className="font-mono">system.webhooks.retry</code>.
          </p>
          {jobs.failedEmails.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No failed outbox emails.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4">Sender</th>
                    <th className="py-2 pr-4">Created</th>
                    <th className="py-2 pr-4">Error</th>
                    {canRetry && <th className="py-2 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {jobs.failedEmails.map((e) => (
                    <tr key={e.id} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{e.id.slice(0, 8)}…</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">{e.sender ?? "—"}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">{when(e.createdAt)}</td>
                      <td className="max-w-[240px] truncate py-2 pr-4 font-mono text-[11px] text-slate-500" title={e.error ?? ""}>{e.error ?? "—"}</td>
                      {canRetry && <td className="py-2 text-right"><RetryButton emailId={e.id} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Observability strip */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">Observability backlog</h2>
            <dl className="mt-3 space-y-1 font-mono text-xs text-slate-300">
              <div className="flex justify-between"><dt>error_events (24h)</dt><dd className="font-bold">{jobs.observability.errorEvents24h ?? "—"}</dd></div>
              <div className="flex justify-between"><dt>open error_issues</dt><dd className="font-bold">{jobs.observability.openErrorIssues ?? "—"}</dd></div>
            </dl>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">Controls</h2>
            <p className="mt-2 text-xs text-slate-400">{jobs.controls.note}</p>
            <p className="mt-2 font-mono text-[11px] text-slate-500">pause/resume: {jobs.controls.pauseResume} · API: POST /api/system/jobs/control</p>
          </div>
        </section>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/jobs</code> ·{" "}
          <code className="font-mono">POST /api/system/jobs/email-outbox/{"{id}"}/retry</code>
        </p>
      </div>
    </SystemGate>
  );
}
