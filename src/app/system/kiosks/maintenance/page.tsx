export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getSystemDevice, SYSTEM_DEVICE_STATUSES, DEVICE_STATUS_TONE as STATUS_TONE } from "@/lib/system/kiosks";
import {
  listMaintenanceVisits, MAINTENANCE_STATUSES, MAINTENANCE_VISIT_TYPES,
  type MaintenanceVisitRow,
} from "@/lib/system/device-config";
import { VisitForm } from "./VisitForm";
import { VisitStatusButtons } from "./VisitStatusButtons";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Maintenance" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const TONE: Record<string, string> = {
  open: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  scheduled: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  in_progress: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  completed: "bg-lime/15 text-lime ring-lime/30",
  cancelled: "bg-white/5 text-slate-500 ring-white/10",
};

export default async function KioskMaintenancePage({ searchParams }: {
  searchParams: Promise<{ status?: string; device_id?: string }>;
}) {
  const { status, device_id } = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  const visits = db
    ? await listMaintenanceVisits(db, { status, deviceId: device_id, limit: 300 }).catch(() => [] as MaintenanceVisitRow[])
    : [];
  // Resolve device labels for the visit list (bounded — page limit 300).
  const deviceIds = [...new Set(visits.map((v) => v.device_id))];
  const deviceLabels = new Map<string, string>();
  if (db && deviceIds.length > 0) {
    const { data } = await db.from("system_devices").select("id,device_uid,serial_number,status").in("id", deviceIds);
    for (const d of (data ?? []) as { id: string; device_uid: string | null; serial_number: string | null; status: string }[]) {
      deviceLabels.set(d.id, `${d.device_uid ?? d.id.slice(0, 8)} (${d.status})`);
    }
  }
  // Device picker for the schedule form (active-ish fleet only).
  const { data: deviceRows } = db
    ? await db.from("system_devices").select("id,device_uid,serial_number,status")
        .in("status", [...SYSTEM_DEVICE_STATUSES.filter((s) => s !== "decommissioned")])
        .order("created_at", { ascending: false }).limit(300)
    : { data: null };

  const statusHref = (s: string) => `/system/kiosks/maintenance${s ? `?status=${s}` : ""}`;

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Kiosk Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Maintenance</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Device-level maintenance visits for <code className="font-mono text-xs">system_devices</code>{" "}
              (<code className="font-mono text-xs">system_maintenance_visits</code>, migration 0059) — separate from
              the legacy rental-kiosk visit log. Workflow: open → scheduled → in_progress → completed/cancelled.
            </p>
          </div>
          <Link href="/system/kiosks" className="text-xs text-slate-400 underline hover:text-white">← Fleet registry</Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 lg:col-span-1">
            <h2 className="eyebrow text-slate-400">Schedule a visit</h2>
            {canManage ? (
              <div className="mt-4">
                <VisitForm
                  devices={((deviceRows ?? []) as { id: string; device_uid: string | null; serial_number: string | null; status: string }[])
                    .map((d) => ({ id: d.id, label: `${d.device_uid ?? d.id.slice(0, 8)} — ${d.serial_number ?? "no serial"} (${d.status})` }))}
                />
              </div>
            ) : (
              <p className="mt-4 text-xs text-slate-500">Read-only — system.kiosks.manage required to schedule.</p>
            )}
          </section>

          <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="eyebrow mr-auto text-slate-400">Visits ({visits.length})</h2>
              {["", ...MAINTENANCE_STATUSES].map((s) => (
                <Link key={s || "all"} href={statusHref(s)}
                  className={`rounded-full px-3 py-1 text-[11px] font-bold ${status === s || (!status && !s) ? "bg-lime text-ink" : "bg-white/10 text-slate-300 ring-1 ring-white/15 hover:bg-white/15"}`}>
                  {s || "All"}
                </Link>
              ))}
            </div>
            {!db ? (
              <p className="text-sm text-slate-400">Backend not configured.</p>
            ) : visits.length === 0 ? (
              <p className="text-sm text-slate-400">No maintenance visits{status ? ` with status "${status}"` : ""} yet.</p>
            ) : (
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Device", "Type", "Status", "Scheduled", "Started", "Completed", "Technician", "Notes", ""].map((h) => <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {visits.map((v) => (
                    <tr key={v.id} className="border-t border-white/5 align-top">
                      <td className="py-2 pr-3 font-mono font-bold text-lime">
                        <Link href={`/system/kiosks/${v.device_id}`} className="hover:underline">
                          {deviceLabels.get(v.device_id) ?? v.device_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-slate-300">{v.visit_type}</td>
                      <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${TONE[v.status] ?? ""}`}>{v.status}</span></td>
                      <td className="whitespace-nowrap py-2 pr-3 font-mono text-slate-400">{when(v.scheduled_at)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 font-mono text-slate-400">{when(v.started_at)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 font-mono text-slate-400">{when(v.completed_at)}</td>
                      <td className="py-2 pr-3 text-slate-300">{v.technician ?? "—"}</td>
                      <td className="max-w-[180px] truncate py-2 pr-3 text-slate-400" title={v.notes ?? ""}>{v.notes ?? "—"}</td>
                      <td className="py-2">{canManage && <VisitStatusButtons visit={v} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-[10px] text-slate-500">
              Visit types: {MAINTENANCE_VISIT_TYPES.join(", ")}. Transitions are edge-checked server-side;
              completed/cancelled are terminal. Device status changes (e.g. → maintenance) remain a
              separate lifecycle action on the device page.
            </p>
          </section>
        </div>
      </div>
    </SystemGate>
  );
}
