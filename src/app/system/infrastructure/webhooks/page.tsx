export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import {
  getWebhookInspector,
  inspectInfraEvent,
  INFRA_WEBHOOK_SOURCES,
  type InfraWebhookSourceId,
} from "@/lib/system/webhook-inspector";
import { ReplayButton } from "../../webhooks/ReplayButton";
import { RetryButton } from "../../jobs/RetryButton";

export const metadata: Metadata = { title: "Infrastructure · Webhook inspector" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-slate-300 ring-1 ring-white/10">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function InfraWebhooksPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const db = serviceClient();
  const { ref } = await searchParams;
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canRetry = roleCan(role, "system.webhooks.retry");

  const report = await getWebhookInspector(db);

  // Optional detail view: ?ref=source:rowId
  let detail: Awaited<ReturnType<typeof inspectInfraEvent>> | null = null;
  if (ref) {
    const decoded = decodeURIComponent(ref);
    const sep = decoded.indexOf(":");
    const source = sep > 0 ? decoded.slice(0, sep) : "";
    const rowId = sep > 0 ? decoded.slice(sep + 1) : "";
    if (db && rowId && (INFRA_WEBHOOK_SOURCES as readonly string[]).includes(source)) {
      detail = await inspectInfraEvent(db, source as InfraWebhookSourceId, rowId);
    } else {
      detail = { ok: false, status: 400, error: "Invalid event ref — expected source:rowId" };
    }
  }

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Infrastructure · Webhooks</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Webhook &amp; event inspector</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            All inbound/event surfaces aggregated: Stripe dedupe ledger, durable inbound-email jobs,
            the inbound mail log (incl. <span className="font-mono">quarantined</span>), Twilio SMS
            callbacks, device-auth telemetry, and the outbound email queue. Whitelisted columns only —
            emails, phone numbers, and bodies are never selected; jsonb passes through{" "}
            <code className="font-mono">sanitizeAuditDetail</code>. Click a row for sanitized detail.
          </p>
        </div>

        {!report.configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — webhook data unavailable.
          </p>
        )}

        {/* Per-source stats */}
        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.06] font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Endpoint</th>
                <th className="px-4 py-3">Events 24h</th>
                <th className="px-4 py-3">Pending</th>
                <th className="px-4 py-3">Failures 24h</th>
                <th className="px-4 py-3">Last event</th>
                <th className="px-4 py-3">Last success</th>
                <th className="px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((s) => (
                <tr key={s.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <p className="font-bold">{s.provider}</p>
                    <p className="font-mono text-[11px] text-slate-500">{s.id}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{s.endpoint}</td>
                  <td className="px-4 py-3 font-mono text-xs">{s.events24h ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">{s.pending ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {s.failures24h == null ? <span className="text-slate-500">not tracked</span> : s.failures24h}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{when(s.lastEventAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{when(s.lastSuccessAt)}</td>
                  <td className="max-w-[260px] px-4 py-3 text-[11px] leading-snug text-slate-500">{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail view */}
        {detail && (
          <section className="rounded-2xl border border-lime/20 bg-lime/[0.03] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="eyebrow text-lime">Event detail</h2>
              <Link href="/system/infrastructure/webhooks" className="font-mono text-[11px] text-slate-400 underline">close</Link>
            </div>
            {!detail.ok ? (
              <p className="mt-3 font-mono text-sm text-red-300">{detail.error} (HTTP {detail.status})</p>
            ) : (
              <div className="mt-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-xs font-bold text-slate-200 ring-1 ring-white/15">{detail.event.source}</span>
                  <span className="font-mono text-xs text-slate-400">{detail.event.ref}</span>
                  <span className="font-mono text-xs text-slate-400">at {when(detail.event.at)}</span>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/10">{detail.event.status}</span>
                </div>
                <JsonBlock value={detail.event.fields} />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {detail.replay.eligible ? (
                    canRetry ? (
                      detail.replay.kind === "inbound_job" ? (
                        <ReplayButton refId={detail.replay.ref} />
                      ) : (
                        <RetryButton emailId={detail.replay.ref.slice("email_outbox:".length)} />
                      )
                    ) : (
                      <span className="font-mono text-[11px] text-slate-500">replay eligible — requires system.webhooks.retry</span>
                    )
                  ) : (
                    <span className="font-mono text-[11px] text-slate-500">replay: {detail.replay.reason}</span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Recent events */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Recent events (latest 8 per source)</h2>
          {report.recent.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No events returned.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Summary</th>
                    <th className="py-2 text-right">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((e) => (
                    <tr key={e.ref} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">{when(e.at)}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-300">{e.source}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                          e.status === "ok" || e.status === "done" || e.status === "accepted" || e.status === "sent" || e.status === "recorded"
                            ? "bg-lime/15 text-lime ring-lime/30"
                            : e.status === "rejected" || e.status === "dead" || e.status === "failed" || e.status === "quarantined"
                              ? "bg-red-500/15 text-red-300 ring-red-400/30"
                              : "bg-white/10 text-slate-300 ring-white/15"
                        }`}>{e.status}</span>
                      </td>
                      <td className="max-w-[380px] py-2 pr-4">
                        <JsonBlock value={e.fields} />
                      </td>
                      <td className="py-2 text-right">
                        <Link href={`/system/infrastructure/webhooks?ref=${encodeURIComponent(e.ref)}`} className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
                          inspect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Quarantine — read-only */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Quarantined inbound mail (read-only)</h2>
          <p className="mt-1 text-xs text-slate-400">
            Mail that failed sender-auth/validation checks. Release/reject decisions happen in the helpdesk
            communication center — this surface never mutates quarantine state.
          </p>
          {report.quarantine.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No quarantined inbound mail.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Reason</th>
                    <th className="py-2 pr-4">Auth</th>
                    <th className="py-2 text-right">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {report.quarantine.map((e) => (
                    <tr key={e.ref} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">{when(e.at)}</td>
                      <td className="max-w-[280px] truncate py-2 pr-4 font-mono text-[11px] text-slate-400" title={String(e.fields.reason ?? "")}>
                        {String(e.fields.reason ?? "—")}
                      </td>
                      <td className="py-2 pr-4 font-mono text-[11px] text-slate-500">
                        dmarc={String(e.fields.dmarc ?? "?")} spf={String(e.fields.spf ?? "?")} dkim={String(e.fields.dkim ?? "?")}
                      </td>
                      <td className="py-2 text-right">
                        <Link href={`/system/infrastructure/webhooks?ref=${encodeURIComponent(e.ref)}`} className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
                          inspect
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-xs text-slate-500">
          APIs: <code className="font-mono">GET /api/system/infrastructure/webhooks</code> ·{" "}
          <code className="font-mono">GET /api/system/infrastructure/webhooks/{"{source}:{rowId}"}</code> ·{" "}
          replay reuses <code className="font-mono">POST /api/system/webhooks/{"{ref}"}/replay</code> (inbound_jobs) and{" "}
          <code className="font-mono">POST /api/system/jobs/email-outbox/{"{id}"}/retry</code> (email_outbox).
          Payment events have no replay path by design.
        </p>
      </div>
    </SystemGate>
  );
}
