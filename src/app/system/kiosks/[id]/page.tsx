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
import { deviceCredentialStatus } from "@/lib/system/device-auth";
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

  const [commands, audit, related] = await Promise.all([
    listDeviceCommands(db, device.id, 100),
    listDeviceAudit(db, device.id, 100),
    device.venue_id ? listVenueLinkedKiosksAndRentals(db, device.venue_id) : Promise.resolve({ kiosks: [], rentals: [] }),
  ]);
  const diagnostics = commands.filter((c) => c.command_type === "diagnostic_ping");
  const conn = deriveConnectivity(device);
  const tokenState = provisionTokenState(device);
  const credential = deviceCredentialStatus(device);
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
            <CredentialPanel deviceId={device.id} canManage={canManage} credential={credential} />
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
