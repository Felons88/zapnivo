export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getIncident, listIncidentEvents, INCIDENT_TRANSITIONS, isIncidentStatus } from "@/lib/system/incidents";
import { AcknowledgeButton } from "../AcknowledgeButton";
import { IncidentActions } from "../IncidentActions";

export const metadata: Metadata = { title: "Incident" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const sevTone = (s: string) =>
  s === "sev1" ? "bg-red-500/20 text-red-200 ring-red-400/40"
  : s === "sev2" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : s === "sev3" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

const statusTone = (s: string) =>
  s === "resolved" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "monitoring" || s === "mitigating" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
  : s === "reopened" ? "bg-orange-500/15 text-orange-300 ring-orange-400/30"
  : s === "investigating" || s === "identified" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

export default async function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canMutate = roleCan(role, "system.changes.request");

  const incident = db && /^[0-9a-f-]{36}$/i.test(id) ? await getIncident(db, id) : null;
  if (!incident) notFound();
  const events = db ? await listIncidentEvents(db, incident.id, 300) : [];
  const targets = isIncidentStatus(incident.status) ? INCIDENT_TRANSITIONS[incident.status] : [];

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Incidents</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">{incident.title}</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              {incident.number} · {incident.id.slice(0, 8)}… ·{" "}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${statusTone(incident.status)}`}>{incident.status}</span>
            </p>
          </div>
          <Link href="/system/incidents" className="text-xs text-slate-400 underline hover:text-white">← Incident register</Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Details</h2>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">severity</dt><dd><span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${sevTone(incident.severity)}`}>{incident.severity}</span></dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">source</dt><dd className="font-mono text-slate-200">{incident.source ?? "—"}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">services</dt><dd className="font-mono text-slate-200">{incident.services.join(", ") || "—"}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">detected</dt><dd className="font-mono text-slate-200">{when(incident.detected_at)}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">acknowledged</dt><dd className="font-mono text-slate-200">{when(incident.acknowledged_at)}</dd></div>
              <div className="flex justify-between gap-4 py-1.5"><dt className="text-slate-500">resolved</dt><dd className="font-mono text-slate-200">{when(incident.resolved_at)}</dd></div>
            </dl>
            {incident.summary && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">summary</summary>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-snug text-slate-400">{incident.summary}</p>
              </details>
            )}
          </section>

          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Actions</h2>
            {canMutate ? (
              <div className="mt-3 flex flex-col gap-3">
                <AcknowledgeButton incidentId={incident.id} acknowledged={!!incident.acknowledged_at} resolved={incident.status === "resolved"} />
                {isIncidentStatus(incident.status) && targets.length > 0 && (
                  <IncidentActions incidentId={incident.id} current={incident.status} targets={targets} />
                )}
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">Mutations require <code className="font-mono">system.changes.request</code>.</p>
            )}
          </section>
        </div>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Transition history ({events.length})</h2>
          {events.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No recorded transitions yet — history begins with the next lifecycle change.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {events.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-2 text-xs last:border-0">
                  <span className="min-w-0">
                    <span className="font-mono font-bold text-slate-200">{e.from_status ?? "—"} → {e.to_status}</span>{" "}
                    <span className="text-slate-500">by {e.actor_id ? e.actor_id.slice(0, 8) : "system"}</span>
                    {e.reason && <span className="ml-2 text-slate-400">“{e.reason}”</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(e.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
