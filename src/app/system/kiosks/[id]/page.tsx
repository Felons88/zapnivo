export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import {
  getSystemDevice, listDeviceCommands, listDeviceAudit, listVenueLinkedKiosksAndRentals,
  DEVICE_TRANSITIONS, transitionRisk, deriveConnectivity, provisionTokenState, kioskAdapterName,
  isUuid, DEVICE_STATUS_TONE as STATUS_TONE, type SystemDeviceRow,
} from "@/lib/system/kiosks";
import { StatusButtons } from "./StatusButtons";
import { ProvisionPanel } from "./ProvisionPanel";
import { CredentialPanel } from "./CredentialPanel";
import { DiagnosticsButton } from "./DiagnosticsButton";
import { CommandForm } from "./CommandForm";
import { deviceCredentialStatus, kekStatus, type DeviceAuthRow } from "@/lib/system/device-auth";
import { getDeviceOpsDashboard } from "@/lib/system/command-ops";
import type { ReadinessCheck } from "@/lib/system/hardware";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Device" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

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

export default async function KioskDevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  if (!db || !isUuid(id)) notFound();
  const device = await getSystemDevice(db, id);
  if (!device) notFound();

  // Venue name join (single-row equivalent of the fleet embed).
  type VenueLite = { id: string; name: string | null; city: string | null };
  let venue: VenueLite | null = null;
  if (device.venue_id) {
    const { data: v } = await db.from("venues").select("id,name,city").eq("id", device.venue_id).maybeSingle();
    venue = (v as VenueLite | null) ?? null;
  }

  const [commands, audit, related, ops] = await Promise.all([
    listDeviceCommands(db, device.id, 100),
    listDeviceAudit(db, device.id, 100),
    device.venue_id ? listVenueLinkedKiosksAndRentals(db, device.venue_id) : Promise.resolve({ kiosks: [], rentals: [] }),
    getDeviceOpsDashboard(db, device),
  ]);
  const diagnostics = commands.filter((c) => c.command_type === "diagnostic_ping");
  const conn = deriveConnectivity(device);
  const tokenState = provisionTokenState(device);
  // Rotation-slot columns arrive with migration 0048 — fetch tolerantly so the
  // page still renders before the migration lands (rotation simply shows none).
  const { data: credCols } = await db.from("system_devices")
    .select("device_secret_enc_next,credential_next_expires_at")
    .eq("id", device.id).maybeSingle();
  const credential = deviceCredentialStatus({
    ...(device as unknown as DeviceAuthRow),
    device_secret_enc_next: (credCols as { device_secret_enc_next?: string | null } | null)?.device_secret_enc_next ?? null,
    credential_next_expires_at: (credCols as { credential_next_expires_at?: string | null } | null)?.credential_next_expires_at ?? null,
  });
  const kek = kekStatus();
  const adapter = kioskAdapterName();
  const latestDiagnostics = diagnostics[0]?.result as { readiness?: ReadinessCheck[] } | null | undefined;
  const transitionTargets = DEVICE_TRANSITIONS[device.status].map((s) => ({ status: s, risk: transitionRisk(s) }));

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
              <span className="font-mono">{device.device_uid ?? device.id.slice(0, 8)}</span>
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              id {device.id} · serial {device.serial_number ?? "—"} ·{" "}
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${STATUS_TONE[device.status] ?? ""}`}>{device.status}</span>
            </p>
          </div>
          <Link href="/system/kiosks" className="text-xs text-slate-400 underline hover:text-white">← Fleet registry</Link>
        </div>

        {adapter === "none" && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
            <strong>Adapter: none — commands disabled.</strong> No hardware adapter is wired in
            (<code className="font-mono">KIOSK_ADAPTER=none</code>), so commands and diagnostics are recorded for
            audit only and never dispatched. Telemetry shown here comes solely from stored timestamps.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Identity */}
          <Section title="Identity">
            <dl>
              <Row k="device_uid" v={device.device_uid ?? "—"} mono />
              <Row k="serial_number" v={device.serial_number ?? "—"} mono />
              <Row k="manufacturer" v={device.manufacturer ?? "—"} />
              <Row k="model" v={device.model ?? "—"} />
              <Row k="gateway" v={device.gateway ?? "—"} mono />
              <Row k="adapter_type" v={device.adapter_type ?? "—"} mono />
              <Row k="slot_count" v={device.slot_count ?? "—"} mono />
              <Row k="firmware_version" v={device.firmware_version ?? "—"} mono />
              <Row k="venue" v={venue ? `${venue.name ?? "venue"}${venue.city ? `, ${venue.city}` : ""}` : device.venue_id ? device.venue_id : "—"} />
              <Row k="region" v={device.region ?? "—"} />
              <Row k="capabilities" v={Object.keys(device.capabilities ?? {}).length ? <code className="break-all text-[10px]">{JSON.stringify(device.capabilities)}</code> : "—"} />
              <Row k="created" v={when(device.created_at)} mono />
              <Row k="created_by" v={device.created_by ? device.created_by.slice(0, 8) : "—"} mono />
            </dl>
          </Section>

          {/* Connectivity — derived only from stored timestamps */}
          <Section title="Connectivity">
            <dl>
              <Row k="derived state" v={
                <span className={conn.kind === "online" ? "text-lime" : conn.kind === "no_data" ? "text-slate-400" : "text-amber-300"}>{conn.label}</span>
              } />
              <Row k="last_heartbeat_at" v={when(device.last_heartbeat_at)} mono />
              <Row k="last_message_at" v={when(device.last_message_at)} mono />
              <Row k="installed_at" v={when(device.installed_at)} mono />
              <Row k="credential_rotated_at" v={when(device.credential_rotated_at)} mono />
              <Row k="updated_at" v={when(device.updated_at)} mono />
            </dl>
            <p className="mt-3 text-[10px] text-slate-500">
              No live ping is possible while the adapter is disabled — "online" only means a heartbeat was
              recorded within the staleness window.
            </p>
          </Section>

          {/* Provisioning */}
          <Section title="Provisioning">
            <dl>
              <Row k="token issued" v={device.provision_token_hash ? "yes (hash stored)" : "no"} />
              <Row k="token state" v={
                <span className={tokenState.state === "issued" ? "text-lime" : tokenState.state === "used" ? "text-cyan-300" : tokenState.state === "expired" ? "text-amber-300" : "text-slate-400"}>
                  {tokenState.state}{"expiresAt" in tokenState && tokenState.expiresAt ? ` · expires ${when(tokenState.expiresAt)}` : ""}
                </span>
              } />
              <Row k="token used_at" v={when(device.provision_token_used_at)} mono />
              <Row k="token expires_at" v={when(device.provision_token_expires_at)} mono />
            </dl>
            <div className="mt-3"><ProvisionPanel deviceId={device.id} canManage={canManage} tokenState={tokenState} /></div>
          </Section>

          {/* Ingest credential (per-device HMAC) */}
          <Section title="Device credential">
            <CredentialPanel deviceId={device.id} canManage={canManage} credential={credential} kek={kek} />
          </Section>

          {/* Lifecycle */}
          <Section title="Lifecycle">
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${STATUS_TONE[device.status] ?? ""}`}>{device.status}</span>
              <StatusButtons deviceId={device.id} targets={transitionTargets} />
            </div>
            <p className="mt-3 text-[10px] text-slate-500">
              Legal edges only; quarantined/decommissioned require an approved change request (high risk).
            </p>
          </Section>
        </div>

        {/* ── Phase 2.6 ops dashboard: verification signals ── */}
        <Section title="Verification signals">
          <p className="mb-3 text-[10px] text-slate-500">
            Each signal is derived only from stored evidence — nothing here claims live hardware contact.
            Bound kiosk(s): {ops.bound_kiosks.length === 0 ? "none" : ops.bound_kiosks.map((k) => k.station_id ?? k.id.slice(0, 8)).join(", ")}.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {([
              ["gateway_reachable", ops.verification.gateway_reachable],
              ["heartbeat_received", ops.verification.heartbeat_received],
              ["ack_received", ops.verification.ack_received],
              ["simulated_evidence", ops.verification.simulated_evidence],
              ["physically_verified", ops.verification.physically_verified],
            ] as const).map(([name, v]) => (
              <div key={name} className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
                <p className="font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{name}</p>
                <p className={`mt-1 font-mono text-[11px] font-bold ${
                  v.state === "yes" ? "text-lime" : v.state === "no" ? "text-slate-400" : "text-amber-300"}`}>
                  {v.state === "unverifiable" ? "unverifiable" : v.state}
                </p>
                <p className="mt-1 text-[10px] leading-snug text-slate-500">{v.detail}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Command queue (device_commands via bound kiosk) ── */}
        <Section title={`Command queue — device_commands (${ops.commands.counts.total})`}>
          {ops.unbound ? (
            <p className="text-sm text-slate-400">
              No rental-facing kiosk is bound to this device (kiosks.station_id ↔ device_uid/serial_number).
              The durable command queue is not applicable until a station binding exists.{" "}
              <Link href="/system/kiosks/commands" className="text-lime underline">Fleet command history →</Link>
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-[11px] font-mono">
                <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-amber-300 ring-1 ring-amber-400/30">open {ops.commands.counts.open}</span>
                <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-red-300 ring-1 ring-red-400/30">failed {ops.commands.counts.failed}</span>
                <span className="rounded-full bg-orange-500/15 px-2.5 py-1 text-orange-300 ring-1 ring-orange-400/30">unknown/investigation {ops.commands.counts.unknown_or_investigation}</span>
                <Link href={`/system/kiosks/commands?device_id=${device.id}`} className="ml-auto rounded-full bg-white/10 px-3 py-1 text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Full history →</Link>
              </div>
              {ops.commands.recent.length === 0 ? (
                <p className="text-sm text-slate-400">No commands recorded for the bound kiosk(s).</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["When", "Command", "State", "Attempt", "Exception", "Idempotency key"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                    <tbody className="font-mono">
                      {ops.commands.recent.slice(0, 15).map((c) => (
                        <tr key={c.id} className="border-t border-white/5">
                          <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{when(c.created_at)}</td>
                          <td className="py-2 pr-4 font-bold"><Link href={`/system/kiosks/commands/${c.id}`} className="text-lime underline decoration-lime/40 hover:text-white">{c.command}</Link></td>
                          <td className="py-2 pr-4 text-slate-300">{c.status}{c.resolved_outcome ? ` →${c.resolved_outcome}` : ""}</td>
                          <td className="py-2 pr-4 text-slate-400">{c.attempt_count}</td>
                          <td className="py-2 pr-4">{c.open_exception ? <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">open</span> : "—"}</td>
                          <td className="max-w-[160px] truncate py-2 text-[10px] text-slate-500" title={c.idempotency_key}>{c.idempotency_key}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[10px] text-slate-500">
                Open = queued|sent|awaiting_ack. Retries are controlled per-command on the detail page
                (MFA + reason + eligibility + evidence for physical commands).
              </p>
            </>
          )}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Recent hardware events */}
          <Section title={`Recent hardware events (${ops.hardware_events.length})`}>
            {ops.hardware_events.length === 0 ? (
              <p className="text-sm text-slate-400">{ops.unbound ? "No bound kiosk — no hardware events can be attributed." : "No device_events recorded for the bound kiosk(s)."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["When", "Event", "Outcome", "Error", "Sim"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                  <tbody className="font-mono">
                    {ops.hardware_events.map((e) => (
                      <tr key={e.id} className="border-t border-white/5">
                        <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{when(e.occurred_at)}</td>
                        <td className="py-2 pr-4 font-bold text-slate-200">{e.event_type}</td>
                        <td className="py-2 pr-4 text-slate-300">{e.outcome ?? "—"}</td>
                        <td className="py-2 pr-4 text-slate-400">{e.error_code ?? "—"}</td>
                        <td className="py-2 text-slate-400">{e.simulated ? "sim" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Open exceptions */}
          <Section title={`Open exceptions (${ops.exceptions.length})`}>
            {ops.exceptions.length === 0 ? (
              <p className="text-sm text-slate-400">No open/investigating rental_exceptions for the bound kiosk(s).</p>
            ) : (
              <ul className="space-y-1.5">
                {ops.exceptions.map((x) => (
                  <li key={x.id} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5 text-xs last:border-0">
                    <span className="font-mono font-bold text-amber-300">{x.kind}</span>
                    <span className="text-slate-500">{x.status} · {when(x.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Inventory */}
          <Section title="Inventory (bound kiosks)">
            {ops.unbound ? (
              <p className="text-sm text-slate-400">No bound kiosk — slot/bank projection is not applicable.</p>
            ) : (
              <>
                <dl>
                  <Row k="bound kiosks" v={ops.inventory.kiosks.map((k) => `${k.station_id ?? k.id.slice(0, 8)} (${k.slot_count ?? "?"} slots)`).join(", ") || "—"} />
                  <Row k="slots by state" v={Object.keys(ops.inventory.slots_by_state).length ? Object.entries(ops.inventory.slots_by_state).map(([s, n]) => `${s}:${n}`).join(", ") : "—"} />
                  <Row k="power banks docked" v={`${ops.inventory.power_banks.docked} active / ${ops.inventory.power_banks.retired} retired / ${ops.inventory.power_banks.total} total`} />
                </dl>
                <p className="mt-2 text-[10px] text-slate-500">Projected from kiosk_slots / power_banks for the bound kiosk id(s) only.</p>
              </>
            )}
          </Section>

          {/* Certification + maintenance */}
          <Section title="Certification & maintenance">
            <dl>
              <Row k="physical-tier latest" v={
                ops.certification.physical_latest
                  ? <span className={ops.certification.physical_latest.status === "pass" ? "text-lime" : "text-amber-300"}>{ops.certification.physical_latest.status} · {ops.certification.physical_latest.check_key} · {when(ops.certification.physical_latest.created_at)}</span>
                  : "no runs recorded"
              } />
              <Row k="runs by tier" v={Object.keys(ops.certification.runs_by_tier).length ? Object.entries(ops.certification.runs_by_tier).map(([t, n]) => `${t}:${n}`).join(", ") : "—"} />
              <Row k="maintenance visits" v={String(ops.maintenance.length)} />
            </dl>
            {ops.maintenance.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {ops.maintenance.slice(0, 5).map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-1.5 text-xs last:border-0">
                    <span className="min-w-0 text-slate-300">{m.notes ? m.notes.slice(0, 80) : "visit"}{m.technician ? ` — ${m.technician.slice(0, 8)}` : ""}</span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">{when(m.visited_at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10px] text-slate-500">
              Certification runs are the append-only system_certification_runs ledger — a physical-tier pass is
              the only hardware-verified signal; simulated/gateway results are labeled separately.
            </p>
          </Section>
        </div>

        {/* Commands */}
        <Section title={`Commands (${commands.filter((c) => c.command_type !== "diagnostic_ping").length})`}>
          <div className="mb-4"><CommandForm deviceId={device.id} canManage={canManage} /></div>
          {commands.filter((c) => c.command_type !== "diagnostic_ping").length === 0 ? (
            <p className="text-sm text-slate-400">No commands recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["When", "Type", "State", "Idempotency key", "Result"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {commands.filter((c) => c.command_type !== "diagnostic_ping").map((c) => (
                    <tr key={c.id} className="border-t border-white/5">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{when(c.created_at)}</td>
                      <td className="py-2 pr-4 font-bold text-slate-200">{c.command_type}</td>
                      <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${c.state === "acked" ? "bg-lime/15 text-lime ring-lime/30" : c.state === "failed" ? "bg-red-500/15 text-red-300 ring-red-400/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{c.state}</span></td>
                      <td className="py-2 pr-4 max-w-[180px] truncate text-slate-500" title={c.idempotency_key ?? ""}>{c.idempotency_key ?? "—"}</td>
                      <td className="py-2 text-[10px] text-slate-400">{c.result ? JSON.stringify(c.result).slice(0, 160) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Diagnostics history */}
        <Section title={`Diagnostics (${diagnostics.length})`}>
          <div className="mb-3"><DiagnosticsButton deviceId={device.id} canManage={canManage} /></div>
          {latestDiagnostics?.readiness && latestDiagnostics.readiness.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {latestDiagnostics.readiness.map((r) => (
                <span key={r.stage} title={r.detail}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                    r.state === "verified" ? "bg-lime/15 text-lime ring-lime/30"
                    : r.state === "failed" ? "bg-red-500/15 text-red-300 ring-red-400/30"
                    : "bg-white/10 text-slate-400 ring-white/15"}`}>
                  {r.stage}:{r.state}
                </span>
              ))}
            </div>
          )}
          {diagnostics.length === 0 ? (
            <p className="text-sm text-slate-400">No diagnostics recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["When", "State", "Result"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {diagnostics.map((c) => (
                    <tr key={c.id} className="border-t border-white/5">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">{when(c.created_at)}</td>
                      <td className="py-2 pr-4 text-slate-300">{c.state}</td>
                      <td className="py-2 text-[10px] text-slate-400">{c.result ? JSON.stringify(c.result).slice(0, 200) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Related rentals — venue-linked only, honestly labeled */}
        <Section title="Related rentals (venue-linked)">
          {!device.venue_id ? (
            <p className="text-sm text-slate-400">No venue assigned — no related rentals can be derived.</p>
          ) : (
            <>
              <p className="mb-3 text-[10px] text-slate-500">
                system_devices has no FK to the rental-facing <code className="font-mono">kiosks</code> table; these are
                matched by shared venue_id and may include unrelated stations at the same venue.
              </p>
              {related.rentals.length === 0 ? (
                <p className="text-sm text-slate-400">No rentals found for kiosks at this venue.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-xs">
                    <thead className="text-[10px] uppercase tracking-wider text-slate-500"><tr>{["Reference", "State", "Station", "Created"].map((h) => <th key={h} className="pb-2 pr-4 font-extrabold">{h}</th>)}</tr></thead>
                    <tbody className="font-mono">
                      {related.rentals.map((r) => (
                        <tr key={r.id} className="border-t border-white/5">
                          <td className="py-2 pr-4 font-bold text-slate-200">{r.reference ?? r.id.slice(0, 8)}</td>
                          <td className="py-2 pr-4 text-slate-300">{r.state}</td>
                          <td className="py-2 pr-4 text-slate-400">{r.kiosk_station_id ?? "—"}</td>
                          <td className="py-2 text-slate-400">{when(r.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {related.kiosks.length > 0 && (
                <p className="mt-3 text-[10px] text-slate-500">
                  {related.kiosks.length} rental kiosk(s) at this venue: {related.kiosks.map((k) => k.station_id).join(", ")}
                </p>
              )}
            </>
          )}
        </Section>

        {/* Status timeline from audit events */}
        <Section title={`Status timeline (${audit.length})`}>
          {audit.length === 0 ? (
            <p className="text-sm text-slate-400">No audit events for this device yet.</p>
          ) : (
            <ul className="space-y-2">
              {audit.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 border-b border-white/5 pb-2 text-xs last:border-0">
                  <span className="min-w-0">
                    <span className="font-mono font-bold text-lime">{a.action}</span>{" "}
                    <span className="text-slate-500">by {a.actor_role ?? "?"} {a.actor_id ? `(${a.actor_id.slice(0, 8)})` : ""}</span>
                    {Object.keys(a.detail ?? {}).length > 0 && (
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
    </SystemGate>
  );
}
