export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listIncidents, INCIDENT_STATUSES } from "@/lib/system/incidents";
import { AcknowledgeButton } from "./AcknowledgeButton";

export const metadata: Metadata = { title: "Incidents" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

const sevTone = (s: string) =>
  s === "sev1" ? "bg-red-500/20 text-red-200 ring-red-400/40"
  : s === "sev2" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : s === "sev3" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

const statusTone = (s: string) =>
  s === "resolved" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "monitoring" || s === "mitigating" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
  : s === "investigating" || s === "identified" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

const FILTERS = ["open", ...INCIDENT_STATUSES] as const;

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = FILTERS.includes(status as (typeof FILTERS)[number]) ? (status as string) : "open";

  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  // No dedicated incident perm — mutations need audit.view (page gate) + changes.request.
  const canMutate = roleCan(role, "system.changes.request");

  const { configured, rows } = await listIncidents(db, { status: filter, limit: 200 });

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Incidents</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Incident register</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Observability incidents from the <code className="font-mono">incidents</code> table (uptime / cron /
            error-spike / manual sources). Acknowledge stamps{" "}
            <code className="font-mono">acknowledged_at</code> only — the status lifecycle is owned by the
            incident workflow. Status changes beyond acknowledgement are{" "}
            <span className="font-mono">not_supported</span> here. Mutations require{" "}
            <code className="font-mono">system.changes.request</code>.
          </p>
        </div>

        {/* Status filter */}
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={f === "open" ? "/system/incidents" : `/system/incidents?status=${f}`}
              className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ring-1 ${
                (filter) === f
                  ? "bg-lime/15 text-lime ring-lime/30"
                  : "bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10"
              }`}
            >
              {f}
            </Link>
          ))}
        </div>

        {!configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — incident data unavailable.
          </p>
        )}

        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.06] font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Incident</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Detected</th>
                <th className="px-4 py-3">Ack / resolved</th>
                {canMutate && <th className="px-4 py-3 text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="max-w-[280px] px-4 py-3">
                    <p className="font-bold text-slate-200">{i.title}</p>
                    <p className="font-mono text-[11px] text-slate-500">{i.number} · {i.id.slice(0, 8)}…</p>
                    {i.summary && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">summary</summary>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-snug text-slate-400">{i.summary}</p>
                      </details>
                    )}
                    {i.services.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {i.services.map((s) => (
                          <span key={s} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-white/10">{s}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${sevTone(i.severity)}`}>{i.severity}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${statusTone(i.status)}`}>{i.status}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{i.source ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{when(i.detected_at)}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-400">
                    <div>ack: {when(i.acknowledged_at)}</div>
                    <div>resolved: {when(i.resolved_at)}</div>
                  </td>
                  {canMutate && (
                    <td className="px-4 py-3 text-right">
                      <AcknowledgeButton incidentId={i.id} acknowledged={!!i.acknowledged_at} resolved={i.status === "resolved"} />
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={canMutate ? 7 : 6} className="px-4 py-8 text-center text-sm text-slate-400">
                  {configured ? "No incidents match this filter." : "No data."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/incidents?status=open</code> ·{" "}
          <code className="font-mono">POST /api/system/incidents/{"{id}"}/acknowledge</code>
        </p>
      </div>
    </SystemGate>
  );
}
