export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listFleetDevices, SYSTEM_DEVICE_STATUSES, deriveConnectivity, DEVICE_STATUS_TONE as STATUS_TONE } from "@/lib/system/kiosks";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Fleet registry" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function KiosksFleetPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");
  const { devices, error } = db ? await listFleetDevices(db, { status, limit: 300 }) : { devices: [], error: undefined };

  const filters = ["", ...SYSTEM_DEVICE_STATUSES];
  const href = (s: string) => `/system/kiosks${s ? `?status=${s}` : ""}`;

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Fleet registry</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Hardware fleet from <code className="font-mono text-xs">system_devices</code>. Connectivity is derived
              only from recorded heartbeats — nothing here claims a live link.{" "}
              <span className="font-mono text-[11px]">Adapter: {process.env.KIOSK_ADAPTER ?? "none"} — commands disabled</span>
            </p>
          </div>
          {canManage && (
            <Link href="/system/kiosks/register" className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">
              + Register kiosk
            </Link>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Link key={f || "all"} href={href(f)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${status === f || (!status && !f) ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>
              {f || "All"}
            </Link>
          ))}
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — fleet registry unavailable.</p>
          ) : error ? (
            <p className="px-6 py-10 text-sm text-red-300">Failed to load devices: {error}</p>
          ) : devices.length === 0 ? (
            <div className="px-6 py-10">
              <p className="text-sm text-slate-400">
                No devices{status ? ` with status "${status}"` : ""} registered yet.
              </p>
              {canManage && (
                <p className="mt-2 text-xs text-slate-500">
                  <Link href="/system/kiosks/register" className="text-lime underline">Register the first kiosk</Link> to start the fleet.
                </p>
              )}
            </div>
          ) : (
            <table className="w-full min-w-[1100px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Device UID", "Serial", "Manufacturer / Model", "Venue", "Slots", "Firmware", "Status", "Connectivity", "Last heartbeat", "Last message", "Registered"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const conn = deriveConnectivity(d);
                  return (
                    <tr key={d.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                      <td className="px-4 py-3">
                        <Link href={`/system/kiosks/${d.id}`} className="font-mono font-bold text-lime hover:underline">{d.device_uid ?? d.id.slice(0, 8)}</Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300">{d.serial_number ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-300">{[d.manufacturer, d.model].filter(Boolean).join(" / ") || "—"}</td>
                      <td className="px-4 py-3 text-slate-300">{d.venue ? `${d.venue.name ?? "venue"}${d.venue.city ? `, ${d.venue.city}` : ""}` : "—"}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{d.slot_count ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{d.firmware_version ?? "—"}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[d.status] ?? ""}`}>{d.status}</span></td>
                      <td className="px-4 py-3">
                        <span className={`font-mono text-[10px] font-bold ${conn.kind === "online" ? "text-lime" : conn.kind === "no_data" ? "text-slate-500" : "text-amber-300"}`}>{conn.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(d.last_heartbeat_at)}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(d.last_message_at)}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(d.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
