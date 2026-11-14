export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getSystemJobs, CRON_ROUTES } from "@/lib/system/jobs";
import { getCronJobDetails } from "@/lib/system/db-admin";
import { JobControlButton } from "../../jobs/JobControl";

export const metadata: Metadata = { title: "Infrastructure · Jobs deep-dive" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

/** Compact JSON for cron_runs.detail — already sanitized server-side. */
function DetailJson({ detail }: { detail: Record<string, unknown> | null }) {
  if (!detail) return <span className="text-slate-600">—</span>;
  const s = JSON.stringify(detail);
  return (
    <details className="group">
      <summary className="cursor-pointer font-mono text-[11px] text-slate-400 hover:text-lime">
        {s.length > 90 ? s.slice(0, 90) + "…" : s}
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] text-slate-300 ring-1 ring-white/10">
        {JSON.stringify(detail, null, 2)}
      </pre>
    </details>
  );
}

export default async function InfraJobsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canControl = roleCan(role, "system.webhooks.retry");
  const [jobs, details] = await Promise.all([getSystemJobs(db), getCronJobDetails(db)]);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Infrastructure · Jobs</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Cron job deep-dive</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Per-job last-run detail from <code className="font-mono">cron_runs.detail</code> (sanitized) and
            observed duration from the latest <code className="font-mono">cron.&lt;job&gt;</code> trace span.
            Queue-level view lives at <Link className="text-lime underline" href="/system/jobs">/system/jobs</Link>.
          </p>
        </div>

        {!jobs.configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — job data unavailable.
          </p>
        )}

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="eyebrow text-slate-400">Cron routes &amp; recorded jobs</h2>
            <p className="font-mono text-[10px] text-slate-500">schedules from vercel.json · all 5 cron routes record cron_runs since Phase 2.7 · pause/resume via jobs.paused (elevation required)</p>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1150px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Route</th>
                  <th className="py-2 pr-4">Schedule (UTC)</th>
                  <th className="py-2 pr-4">Next run</th>
                  <th className="py-2 pr-4">Job</th>
                  <th className="py-2 pr-4">Last run</th>
                  <th className="py-2 pr-4">Result</th>
                  <th className="py-2 pr-4">Duration (last span)</th>
                  <th className="py-2 pr-4">Runs/Failed 24h</th>
                  <th className="py-2 pr-4">Dependencies</th>
                  <th className="py-2 pr-4">Last detail / error</th>
                  <th className="py-2">Control</th>
                </tr>
              </thead>
              <tbody>
                {CRON_ROUTES.flatMap((route) =>
                  route.jobs.map((jobName) => {
                    const c = jobs.cron.find((x) => x.job === jobName && x.route === route.path);
                    const d = details.get(jobName);
                    return (
                      <tr key={`${route.path}:${jobName}`} className="border-b border-white/5 align-top last:border-0">
                        <td className="py-2 pr-4 font-mono text-xs">{route.path}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-slate-400">{route.schedule}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-slate-300">{when(c?.nextRunAt ?? null)}</td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {jobName}
                          {c?.paused && <span className="ml-1 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300 ring-1 ring-amber-400/30">paused</span>}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-slate-300">{when(c?.lastRunAt ?? d?.lastRunAt ?? null)}</td>
                        <td className="py-2 pr-4">
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                            (c?.lastOk ?? d?.lastOk) == null ? "bg-white/10 text-slate-400 ring-white/15"
                            : (c?.lastOk ?? d?.lastOk) ? "bg-lime/15 text-lime ring-lime/30"
                            : "bg-red-500/15 text-red-300 ring-red-400/30"
                          }`}>
                            {(c?.lastOk ?? d?.lastOk) == null ? "no runs" : (c?.lastOk ?? d?.lastOk) ? "ok" : "failed"}
                          </span>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {d?.lastDurationMs == null ? <span className="text-slate-600">no span</span> : `${d.lastDurationMs}ms`}
                          {d?.lastSpanStatus && d.lastSpanStatus !== "ok" && (
                            <span className="ml-1 text-red-300">({d.lastSpanStatus})</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">{c ? `${c.runs24h} / ${c.failures24h}` : "—"}</td>
                        <td className="max-w-[160px] py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {(c?.dependencies ?? []).map((dep) => (
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
                            <span className="font-mono text-[11px] text-red-300/90">{d.lastError}</span>
                          ) : (
                            <DetailJson detail={d?.lastDetail ?? null} />
                          )}
                        </td>
                        <td className="py-2">
                          {canControl && c ? (
                            <JobControlButton job={jobName} paused={c.paused} />
                          ) : (
                            <span className="font-mono text-[10px] text-slate-600">{c?.paused ? "paused" : "—"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Duration is the most recent <code className="font-mono">trace_spans</code> row named{" "}
            <code className="font-mono">cron.&lt;job&gt;</code> — spans are fire-and-forget telemetry, so a missing
            span means the job ran before tracing or the insert was dropped; it is not a failure signal.{" "}
            <code className="font-mono">cron_runs</code> has no duration column — this is the honest closest signal.
          </p>
        </section>

        <p className="font-mono text-[11px] text-slate-600">
          API: GET /api/system/jobs · GET /api/system/infrastructure/webhooks (queue surfaces)
        </p>
      </div>
    </SystemGate>
  );
}
