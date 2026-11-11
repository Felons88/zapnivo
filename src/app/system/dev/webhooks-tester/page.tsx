export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listWebhookSources } from "@/lib/system/webhooks";
import { listRecentWebhookRows } from "@/lib/system/devtools";

export const metadata: Metadata = { title: "Webhook Tester" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

const statusTone = (s: string | null) =>
  !s ? "bg-white/10 text-slate-400 ring-white/15"
  : /fail|dead|reject|error|quarantine/i.test(s) ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : /done|processed|accepted|recorded|ok/i.test(s) ? "bg-lime/15 text-lime ring-lime/30"
  : "bg-amber-400/15 text-amber-300 ring-amber-400/30";

/**
 * Read-only webhook/event inspector. Shows sanitized metadata for the most
 * recent rows per source (payloads and PII columns are never selected).
 * Replay is NOT here — it lives on /system/webhooks for inbound_jobs
 * failed/dead rows (the only safely replayable type).
 */
export default async function WebhookTesterPage() {
  const db = serviceClient();
  const [sources, rows] = await Promise.all([listWebhookSources(db), listRecentWebhookRows(db, 5)]);

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / Webhook Tester</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Webhook event inspector</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Recent rows across the real webhook tables with <strong className="text-slate-200">sanitized
            metadata only</strong> — payloads, email bodies, phone numbers, and PII columns are never selected.
            This is an inspector, not a replay tool:{" "}
            <Link href="/system/webhooks" className="underline hover:text-white">/system/webhooks</Link> owns replay
            (inbound_jobs failed/dead only, requires <code className="font-mono">system.webhooks.retry</code>).
          </p>
        </div>

        {/* Source summary */}
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
          {sources.map((s) => (
            <section key={s.source} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
              <p className="font-mono text-xs font-bold text-slate-200">{s.provider}</p>
              <p className="mt-0.5 font-mono text-[10px] text-slate-500">{s.source}</p>
              <p className="mt-2 font-mono text-lg font-bold">{s.lastEventAt ? when(s.lastEventAt) : "never"}</p>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">last event</p>
              {s.failures24h != null && (
                <p className={`mt-1 font-mono text-[11px] ${s.failures24h > 0 ? "text-red-300" : "text-slate-400"}`}>
                  {s.failures24h} failure(s) 24h
                </p>
              )}
            </section>
          ))}
        </div>

        {/* Recent rows */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Recent events (sanitized)</h2>
          {rows.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              {db ? "No webhook/event rows recorded yet." : "Backend not configured — no data."}
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Ref</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Detail</th>
                    <th className="py-2">At</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={`${r.source}:${r.ref ?? idx}`} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-300">{r.source}</td>
                      <td className="py-2 pr-4 font-mono text-[11px] text-slate-400">{r.ref ? `${r.ref.split(":")[0]}:${String(r.ref.split(":")[1]).slice(0, 8)}…` : "—"}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${statusTone(r.status)}`}>{r.status ?? "—"}</span>
                      </td>
                      <td className="max-w-[280px] truncate py-2 pr-4 font-mono text-[11px] text-slate-500" title={r.detail}>{r.detail}</td>
                      <td className="py-2 font-mono text-[11px] text-slate-400">{when(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-500">
            Inspector refs use <code className="font-mono">{"{source}:{rowId}"}</code> — full sanitized detail via{" "}
            <code className="font-mono">GET /api/system/webhooks/{"{source}:{rowId}"}</code>.
          </p>
        </section>
      </div>
    </SystemGate>
  );
}
