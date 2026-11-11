export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listWebhookSources } from "@/lib/system/webhooks";
import { scrub } from "@/lib/observability";
import { ReplayButton } from "./ReplayButton";

export const metadata: Metadata = { title: "Webhooks" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

export default async function WebhooksPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canRetry = roleCan(role, "system.webhooks.retry");

  const sources = await listWebhookSources(db);

  // Recent failed/dead inbound jobs — the only replayable event rows.
  let deadJobs: { id: string; status: string; attempts: number; created_at: string; last_error: string | null }[] = [];
  if (db) {
    const { data } = await db
      .from("inbound_jobs")
      .select("id,status,attempts,created_at,last_error")
      .in("status", ["failed", "dead"])
      .order("created_at", { ascending: false })
      .limit(20);
    deadJobs = ((data ?? []) as typeof deadJobs).map((j) => ({ ...j, last_error: scrub(j.last_error, 200) || null }));
  }

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Webhooks</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Event sources</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Aggregated from the real webhook/ingest tables. Inspectors return sanitized metadata only —
            payloads and PII (emails, phones, bodies) are never exposed. Replay is limited to{" "}
            <span className="font-mono">inbound_jobs</span> failed/dead rows (idempotent requeue); everything
            else returns <span className="font-mono">replay_unsupported</span>.
          </p>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03] font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Last event</th>
                <th className="px-4 py-3">Counts</th>
                <th className="px-4 py-3">Pending</th>
                <th className="px-4 py-3">Failures 24h</th>
                <th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <p className="font-bold">{s.provider}</p>
                    <p className="font-mono text-[11px] text-slate-500">{s.source}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{s.endpoint}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{when(s.lastEventAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(s.counts).map(([k, v]) => (
                        <span key={k} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/10">
                          {k}:{v}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{s.pending ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {s.failures24h == null ? <span className="text-slate-600">not tracked</span> : s.failures24h}
                  </td>
                  <td className="max-w-[240px] px-4 py-3 text-[11px] leading-snug text-slate-500">{s.note}</td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Backend not configured — no data.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="eyebrow text-slate-400">Failed / dead inbound jobs</h2>
          <p className="mt-1 text-xs text-slate-400">
            The only replayable rows. Requeue sets status → queued; the /api/cron/inbound worker re-processes
            with dedupe on message_id. Requires <code className="font-mono">system.webhooks.retry</code>.
          </p>
          {deadJobs.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No failed or dead inbound jobs.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Job</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Attempts</th>
                    <th className="py-2 pr-4">Created</th>
                    <th className="py-2 pr-4">Last error</th>
                    {canRetry && <th className="py-2 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {deadJobs.map((j) => (
                    <tr key={j.id} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{j.id.slice(0, 8)}…</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${j.status === "dead" ? "bg-red-500/15 text-red-300 ring-red-400/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>{j.status}</span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{j.attempts}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">{when(j.created_at)}</td>
                      <td className="max-w-[260px] truncate py-2 pr-4 font-mono text-[11px] text-slate-500" title={j.last_error ?? ""}>{j.last_error ?? "—"}</td>
                      {canRetry && (
                        <td className="py-2 text-right">
                          <ReplayButton refId={`inbound_jobs:${j.id}`} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/webhooks</code> ·{" "}
          <code className="font-mono">GET /api/system/webhooks/{"{source}:{rowId}"}</code> ·{" "}
          <code className="font-mono">POST /api/system/webhooks/{"{source}:{rowId}"}/replay</code>
        </p>
      </div>
    </SystemGate>
  );
}
