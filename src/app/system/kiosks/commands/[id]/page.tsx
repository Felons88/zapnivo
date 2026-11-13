export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getCommandDetail, DISPENSE_EVIDENCE_COMMANDS, type CommandDetail } from "@/lib/system/command-ops";
import { PHYSICAL_COMMANDS, OPEN_COMMAND_STATES } from "@/lib/kiosk/commands";
import { RequeueForm } from "./RequeueForm";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Command detail" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + "Z" : "—";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 py-1.5 last:border-0">
      <dt className="shrink-0 text-slate-500">{k}</dt>
      <dd className={`text-right text-slate-200 ${mono ? "font-mono text-[11px]" : "text-xs"}`}>{v}</dd>
    </div>
  );
}

const stateTone = (s: string) =>
  s === "acknowledged" || s === "confirmed" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "failed" || s === "unknown_outcome" || s === "requires_investigation" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : OPEN_COMMAND_STATES.has(s) ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
  : "bg-white/10 text-slate-300 ring-white/15";

const ackTone = (c: string) =>
  c === "positive" ? "bg-lime/15 text-lime ring-lime/30"
  : c === "negative" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : "bg-white/10 text-slate-400 ring-white/15";

export default async function CommandDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");
  if (!db) notFound();

  const d: CommandDetail | null = await getCommandDetail(db, id);
  if (!d) notFound();
  const c = d.command;
  const physical = PHYSICAL_COMMANDS.has(c.command);
  const evidenceCommand = DISPENSE_EVIDENCE_COMMANDS.has(c.command);

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure · Command</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
              <span className="font-mono">{c.command}</span>
              {physical && <span className="ml-3 rounded-full bg-orange-500/15 px-3 py-1 align-middle text-[10px] font-extrabold text-orange-300 ring-1 ring-orange-400/30">PHYSICAL</span>}
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              <Link href={`/system/kiosks/commands/${c.id}`} className="text-slate-500">{c.id}</Link>
              {" · "}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${stateTone(c.status)}`}>{c.status}</span>
              {c.resolved_outcome && <span className="ml-2 text-slate-500">resolved: {c.resolved_outcome}</span>}
            </p>
          </div>
          <div className="flex gap-4 text-xs">
            <Link href="/system/kiosks/commands" className="text-slate-400 underline hover:text-white">← Command history</Link>
            {d.system_device && <Link href={`/system/kiosks/${d.system_device.id}`} className="text-slate-400 underline hover:text-white">Device ops →</Link>}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Lifecycle */}
          <Section title="Lifecycle">
            <dl>
              <Row k="status" v={<span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${stateTone(c.status)}`}>{c.status}</span>} />
              <Row k="attempt_count" v={String(c.attempt_count)} mono />
              <Row k="created_at" v={when(c.created_at)} mono />
              <Row k="last_transition_at" v={when(c.last_transition_at)} mono />
              <Row k="resolved_at" v={when(c.resolved_at)} mono />
              <Row k="resolved_outcome" v={c.resolved_outcome ?? "—"} mono />
              <Row k="expires_at" v={when(c.expires_at)} mono />
              <Row k="expected_response_types" v={c.expected_response_types?.length ? <code className="break-all text-[10px]">{c.expected_response_types.join(", ")}</code> : "any"} />
              <Row k="issued_by" v={c.issued_by ? c.issued_by.slice(0, 8) : "—"} mono />
            </dl>
          </Section>

          {/* Retry lineage */}
          <Section title="Retry lineage">
            <dl>
              <Row k="attempt_count" v={String(d.retry.attempt_count)} mono />
              <Row k="requeueable" v={d.retry.requeueable ? <span className="text-lime">yes</span> : <span className="text-slate-400">no</span>} />
            </dl>
            <p className="mt-3 text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Idempotency keys (dead → live)</p>
            <ul className="mt-1 space-y-1">
              {d.retry.idempotency_keys.map((k, i) => (
                <li key={k} className="font-mono text-[10px] text-slate-400">
                  {i === d.retry.idempotency_keys.length - 1 ? "▸ " : "  "}{k}
                  {i === d.retry.idempotency_keys.length - 1 && <span className="ml-2 text-lime">current</span>}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[10px] text-slate-500">
              Each requeue mints a fresh <code className="font-mono">:rN</code> key — acks for dead keys become
              unknown_command evidence, never resolutions.
            </p>
          </Section>

          {/* Device binding */}
          <Section title="Device binding">
            {!d.kiosk ? (
              <p className="text-sm text-slate-400">The target kiosk row no longer exists.</p>
            ) : (
              <dl>
                <Row k="kiosk_id" v={d.kiosk.id} mono />
                <Row k="station_id" v={d.kiosk.station_id ?? "—"} mono />
                <Row k="kiosk state" v={d.kiosk.state} />
                <Row k="bound system_devices" v={d.bound_device_count === 0 ? "none — legacy/unregistered station" : `${d.bound_device_count} row(s)`} />
                {d.system_device && (
                  <>
                    <Row k="device id" v={<Link className="text-lime underline" href={`/system/kiosks/${d.system_device.id}`}>{d.system_device.id.slice(0, 8)}</Link>} mono />
                    <Row k="device_uid" v={d.system_device.device_uid ?? "—"} mono />
                    <Row k="serial" v={d.system_device.serial_number ?? "—"} mono />
                    <Row k="device status" v={d.system_device.status} />
                  </>
                )}
              </dl>
            )}
          </Section>

          {/* Payload (sanitized) */}
          <Section title="Payload (sanitized)">
            {c.payload == null ? (
              <p className="text-sm text-slate-400">No payload recorded.</p>
            ) : (
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[10px] text-slate-300">{JSON.stringify(c.payload, null, 2)}</pre>
            )}
            <p className="mt-2 text-[10px] text-slate-500">Credential/header-shaped keys are stripped server-side before display.</p>
          </Section>
        </div>

        {/* Controlled retry */}
        <Section title="Controlled retry">
          {canManage ? (
            <RequeueForm
              commandId={c.id} command={c.command} physical={physical}
              evidenceCommand={evidenceCommand} requeueable={d.retry.requeueable}
            />
          ) : (
            <p className="text-xs text-slate-500">Requires system.kiosks.manage to requeue commands.</p>
          )}
          <p className="mt-3 text-[10px] text-slate-500">
            Requeue only re-queues this existing command — no new payloads are accepted. Physical commands
            require fresh MFA elevation, an explicit allow-physical opt-in, and (for dispense/return_slot)
            evidence that the previous attempt did not complete.
          </p>
        </Section>

        {/* Correlated ack events */}
        <Section title={`Correlated ack events (${d.ack_events.length})`}>
          {d.ack_events.length === 0 ? (
            <p className="text-sm text-slate-400">No device_events correlate to this command (by command uuid or idempotency key lineage).</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["When", "Event", "Outcome", "Error", "Class", "Simulated"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {d.ack_events.map((e) => (
                    <tr key={e.id} className="border-t border-white/5">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{when(e.occurred_at)}</td>
                      <td className="py-2 pr-4 font-bold text-slate-200">{e.event_type}</td>
                      <td className="py-2 pr-4 text-slate-300">{e.outcome ?? "—"}</td>
                      <td className="py-2 pr-4 text-slate-400">{e.error_code ?? "—"}</td>
                      <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${ackTone(e.classification)}`}>{e.classification}</span></td>
                      <td className="py-2 text-slate-400">{e.simulated ? "yes — not hardware truth" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Rental + exceptions */}
          <Section title="Rental & exceptions">
            {d.rental ? (
              <dl>
                <Row k="rental" v={d.rental.reference ?? d.rental.id.slice(0, 8)} />
                <Row k="rental state" v={d.rental.state} />
                <Row k="rental id" v={d.rental.id} mono />
              </dl>
            ) : (
              <p className="text-sm text-slate-400">No rental linked in the command payload.</p>
            )}
            {d.exceptions.length > 0 && (
              <div className="mt-4">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Related exceptions</p>
                <ul className="mt-1 space-y-1">
                  {d.exceptions.map((x) => (
                    <li key={x.id} className="font-mono text-[10px] text-slate-400">
                      {x.kind} · {x.status} · {when(x.created_at)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          {/* Audit trail */}
          <Section title={`Audit trail (${d.audit_events.length})`}>
            {d.audit_events.length === 0 ? (
              <p className="text-sm text-slate-400">No audit events recorded for this command yet.</p>
            ) : (
              <ul className="space-y-2">
                {d.audit_events.map((a) => (
                  <li key={`${a.source}-${a.id}`} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-2 text-xs last:border-0">
                    <span className="min-w-0">
                      <span className="font-mono font-bold text-lime">{a.action}</span>{" "}
                      <span className="text-slate-500">[{a.source}] {a.actor_role ?? a.actor_id?.slice(0, 8) ?? "?"}</span>
                      {a.detail != null && Object.keys((a.detail ?? {}) as object).length > 0 && (
                        <code className="ml-2 break-all text-[10px] text-slate-500">{JSON.stringify(a.detail).slice(0, 140)}</code>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </SystemGate>
  );
}
