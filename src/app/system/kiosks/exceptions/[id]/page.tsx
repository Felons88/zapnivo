export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listSystemUsers } from "@/lib/system/security";
import {
  EXCEPTION_TRANSITIONS, FINANCIAL_EXCEPTION_KINDS, LEGACY_DISMISSED_STATE,
  getException, isExceptionState,
} from "@/lib/system/exceptions";
import { ExceptionControls, type AssigneeOption } from "../ExceptionControls";

export const metadata: Metadata = { title: "Rental Exception" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const STATE_TONE: Record<string, string> = {
  new: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  investigating: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  awaiting_device: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  awaiting_support: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  requires_financial_review: "bg-red-500/15 text-red-300 ring-red-400/30",
  resolved: "bg-lime/15 text-lime ring-lime/30",
  reopened: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  dismissed: "bg-white/5 text-slate-500 ring-white/10",
};
const stateTone = (s: string | null) => STATE_TONE[s ?? ""] ?? "bg-white/10 text-slate-300 ring-white/15";

const JsonBlock = ({ value, label }: { value: unknown; label?: string }) => (
  <details className="mt-1">
    <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">{label ?? "payload"}</summary>
    <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-snug text-slate-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  </details>
);

export default async function ExceptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");
  // Assignee directory requires the security-audit read perm — otherwise the
  // raw assigned_to id is shown and assignment falls back to id-only display.
  const canSeeDirectory = roleCan(role, "system.security.audit.view");

  const detail = db && /^[0-9a-f-]{36}$/i.test(id) ? await getException(db, id) : null;
  if (!detail) notFound();
  const { exception: ex, evidence } = detail;

  const state = ex.state;
  const targets = state && state !== LEGACY_DISMISSED_STATE && isExceptionState(state)
    ? EXCEPTION_TRANSITIONS[state]
    : [];
  const financial =
    (FINANCIAL_EXCEPTION_KINDS as readonly string[]).includes(ex.kind) ||
    ex.detail?.financial_review === true ||
    ex.detail?.financial_review_required === true;

  let assignees: AssigneeOption[] | null = null;
  if (db && canSeeDirectory) {
    const users = await listSystemUsers(db);
    assignees = users
      .filter((u) => !u.suspended)
      .map((u) => ({ id: u.id, label: `${u.full_name ?? u.email} · ${u.system_role ?? u.business_role}` }));
  }

  const conn = evidence.kiosk?.last_seen_at
    ? (() => {
        const mins = Math.max(0, Math.round((Date.now() - new Date(evidence.kiosk!.last_seen_at!).getTime()) / 60_000));
        return mins <= 30 ? `seen ${mins}m ago` : `last seen ${Math.floor(mins / 60)}h ${mins % 60}m ago`;
      })()
    : evidence.kiosk ? "never reported" : "unknown";

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Rental exceptions</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
              {ex.kind} <span className="font-mono text-lg text-slate-400">#{ex.id.slice(0, 8)}</span>
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${stateTone(state)}`}>{state ?? ex.status}</span>
              {" · "}raised {when(ex.created_at)}
              {ex.reopened_count > 0 ? ` · reopened ×${ex.reopened_count}` : ""}
            </p>
          </div>
          <Link href="/system/kiosks/exceptions" className="text-xs text-slate-400 underline hover:text-white">← Exception register</Link>
        </div>

        {financial && (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            Financial review involved ({ex.kind}). This flag is informational — resolving the exception closes the
            investigation record only; money decisions remain in fin_cases and are never automated here.
          </p>
        )}
        {evidence.warnings.length > 0 && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Partial evidence — some sources failed to load: {evidence.warnings.join("; ")}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Details */}
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Details</h2>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">state</dt><dd className="font-mono text-slate-200">{state ?? ex.status}{ex.status === "open" ? " (legacy 'open')" : ""}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">kind</dt><dd className="font-mono text-slate-200">{ex.kind}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">kiosk</dt><dd className="font-mono text-slate-200">{ex.kiosk_id ?? "—"}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">rental</dt><dd className="font-mono text-slate-200">{ex.rental_id ?? "—"}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">assigned</dt><dd className="font-mono text-slate-200">{ex.assigned_to ?? "unassigned"}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">created</dt><dd className="font-mono text-slate-200">{when(ex.created_at)}</dd></div>
              <div className="flex justify-between gap-4 border-b border-white/5 py-1.5"><dt className="text-slate-500">updated</dt><dd className="font-mono text-slate-200">{when(ex.updated_at)}</dd></div>
              <div className="flex justify-between gap-4 py-1.5"><dt className="text-slate-500">resolved</dt><dd className="font-mono text-slate-200">{when(ex.resolved_at)}</dd></div>
            </dl>
            {ex.resolution_notes && (
              <div className="mt-3 rounded-lg bg-black/30 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">resolution notes</p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{ex.resolution_notes}</p>
              </div>
            )}
            <JsonBlock value={ex.detail} label="exception detail (sanitized)" />
          </section>

          {/* Evidence */}
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Evidence</h2>
            <div className="mt-3 space-y-3 text-xs">
              <div className="rounded-lg bg-black/30 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Kiosk</p>
                {evidence.kiosk ? (
                  <p className="mt-1 font-mono text-slate-200">
                    {evidence.kiosk.station_id} · {evidence.kiosk.state} · {conn}
                    {evidence.kiosk.model ? ` · ${evidence.kiosk.model}` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-slate-500">{ex.kiosk_id ? "kiosk row not found" : "no kiosk linked"}</p>
                )}
              </div>
              <div className="rounded-lg bg-black/30 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Rental</p>
                {evidence.rental ? (
                  <p className="mt-1 font-mono text-slate-200">
                    {evidence.rental.reference ?? evidence.rental.id.slice(0, 8)} · {evidence.rental.state}
                    {evidence.rental.return_disputed ? " · return disputed" : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-slate-500">{ex.rental_id ? "rental row not found" : "no rental linked"}</p>
                )}
              </div>
              <div className="rounded-lg bg-black/30 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Correlated command</p>
                {evidence.command ? (
                  <p className="mt-1 font-mono text-slate-200">
                    {evidence.command.command} · {evidence.command.status} · {when(evidence.command.created_at)}
                  </p>
                ) : (
                  <p className="mt-1 text-slate-500">
                    {ex.detail?.command_id ? "command row not found" : "no command_id in exception detail"}
                  </p>
                )}
                {evidence.command?.payload && <JsonBlock value={evidence.command.payload} label="command payload" />}
              </div>
            </div>
          </section>
        </div>

        {/* Device event timeline */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Device event timeline ({evidence.device_events.length})</h2>
          {evidence.device_events.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              {ex.kiosk_id ? "No device_events recorded for this kiosk." : "No kiosk linked — no timeline."}
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {evidence.device_events.map((e) => (
                <li key={String(e.id)} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5 text-xs last:border-0">
                  <span className="min-w-0">
                    <span className="font-mono font-bold text-slate-200">{e.event_type}</span>
                    {e.slot_number != null && <span className="ml-2 text-slate-500">slot {e.slot_number}</span>}
                    {e.payload && <JsonBlock value={e.payload} label="payload" />}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(e.occurred_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Notes + actions */}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Notes ({ex.notes.length})</h2>
            {ex.notes.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No investigation notes yet.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {ex.notes.map((n, i) => (
                  <li key={i} className="border-b border-white/5 pb-2 text-xs last:border-0">
                    <span className="font-mono text-[10px] text-slate-500">{when(n.at)} · {n.by ? n.by.slice(0, 8) : "system"}</span>
                    <p className="mt-0.5 whitespace-pre-wrap text-slate-300">{n.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">Actions</h2>
            {canManage && state && state !== LEGACY_DISMISSED_STATE ? (
              <ExceptionControls
                exceptionId={ex.id}
                current={state}
                targets={targets}
                assignedTo={ex.assigned_to}
                assignees={assignees}
              />
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                {state === LEGACY_DISMISSED_STATE
                  ? "Legacy dismissed exceptions are terminal — no actions available."
                  : "Mutations require system.kiosks.manage."}
              </p>
            )}
          </section>
        </div>

        {/* Audit history */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Audit history ({evidence.history.length})</h2>
          {evidence.history.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No audit events recorded for this exception yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {evidence.history.map((h) => (
                <li key={h.id} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5 text-xs last:border-0">
                  <span className="min-w-0">
                    <span className="font-mono font-bold text-slate-200">{h.action}</span>{" "}
                    <span className="text-slate-500">by {h.actor_role ?? "system"}{h.actor_id ? ` (${h.actor_id.slice(0, 8)})` : ""}</span>
                    {Object.keys(h.detail).length > 0 && <JsonBlock value={h.detail} label="detail" />}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(h.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
