export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listFleetDevices, SYSTEM_DEVICE_STATUSES, deriveConnectivity, DEVICE_STATUS_TONE as STATUS_TONE } from "@/lib/system/kiosks";
import { getFleetStats, listFleetDevicesFiltered } from "@/lib/system/fleet-stats";

export const metadata: Metadata = { title: "Kiosk Infrastructure — Fleet registry" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function KiosksFleetPage({ searchParams }: {
  searchParams: Promise<{
    status?: string; venue_id?: string; region?: string;
    connectivity?: string; cert_tier?: string; cert_status?: string;
  }>;
}) {
  const sp = await searchParams;
  const { status, venue_id, region, connectivity, cert_tier, cert_status } = sp;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");
  const hasExtraFilters = !!(venue_id || region || connectivity || cert_tier || cert_status);
  const [fleet, stats] = db
    ? await Promise.all([
        hasExtraFilters
          ? listFleetDevicesFiltered(db, { status, venue_id, region, connectivity, cert_tier, cert_status, limit: 300 })
          : listFleetDevices(db, { status, limit: 300 }),
        getFleetStats(db).catch(() => null),
      ])
    : [{ devices: [], error: undefined as string | undefined }, null];
  const { devices, error } = fleet;
  const s = stats && !("error" in stats) ? stats : null;
  // Venue filter options come straight from the venues table (ids, not names).
  const { data: venueRows } = db
    ? await db.from("venues").select("id,name,city").order("name").limit(200)
    : { data: null };

  const filters = ["", ...SYSTEM_DEVICE_STATUSES];
  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status, venue_id, region, connectivity, cert_tier, cert_status, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const str = p.toString();
    return `/system/kiosks${str ? `?${str}` : ""}`;
  };
  const statusHref = (s: string) => qs({ status: s || undefined });
  const venueOptions = ((venueRows ?? []) as { id: string; name: string | null; city: string | null }[])
    .map((v) => ({ id: v.id, label: `${v.name ?? "venue"}${v.city ? `, ${v.city}` : ""}` }));
  const regionOptions = s?.regions ? Object.keys(s.regions).slice(0, 30) : [];
  const certTiers = s?.certification?.tiers ? Object.keys(s.certification.tiers) : [];
  const certStatuses = cert_tier && s?.certification?.tiers?.[cert_tier]
    ? Object.keys(s.certification.tiers[cert_tier]) : ["pass", "fail", "blocked", "skipped"];

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
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/system/kiosks/maintenance" className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Maintenance</Link>
            <Link href="/system/kiosks/provision-qr" className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Provision QR</Link>
            {canManage && (
              <Link href="/system/kiosks/register" className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">
                + Register kiosk
              </Link>
            )}
          </div>
        </div>

        {/* Fleet stats — real DB counts; null sections render as "—" */}
        {s && (
          <section className="grid gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4 sm:grid-cols-2 lg:grid-cols-6">
            {([
              ["Devices", String(s.total)],
              ["Online / stale / no data", `${s.connectivity.online} / ${s.connectivity.stale} / ${s.connectivity.no_data}`],
              ["Faulted (7d)", s.faulted == null ? "—" : String(s.faulted)],
              ["Open commands", s.pending_commands == null ? "—" : String(s.pending_commands)],
              ["Credential issues", s.credential_issues == null ? "—" : String(s.credential_issues.expired + s.credential_issues.revoked + s.credential_issues.pending + s.credential_issues.rotation_pending + s.credential_issues.rotation_overdue)],
              ["Physical cert pass", s.certification?.tiers?.physical?.pass != null ? String(s.certification.tiers.physical.pass) : "—"],
            ] as const).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2">
                <p className="font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">{k}</p>
                <p className="mt-1 font-mono text-lg font-bold text-slate-100">{v}</p>
              </div>
            ))}
            {s.errors.length > 0 && (
              <p className="col-span-full text-[10px] text-amber-300/80">Partial stats — {s.errors.join("; ")}</p>
            )}
          </section>
        )}

        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Link key={f || "all"} href={statusHref(f)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${status === f || (!status && !f) ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>
              {f || "All"}
            </Link>
          ))}
        </div>

        {/* Extended filters — server-side query params */}
        <form method="get" action="/system/kiosks" className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
          {status && <input type="hidden" name="status" value={status} />}
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Venue
            <select name="venue_id" defaultValue={venue_id ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200">
              <option value="">All venues</option>
              {venueOptions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Region
            <select name="region" defaultValue={region ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200">
              <option value="">All regions</option>
              {regionOptions.map((r) => <option key={r} value={r}>{r} ({s?.regions?.[r] ?? "?"})</option>)}
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Connectivity
            <select name="connectivity" defaultValue={connectivity ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200">
              <option value="">Any</option>
              <option value="online">online (fresh heartbeat)</option>
              <option value="stale">stale/offline</option>
              <option value="no_data">no heartbeat data</option>
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Latest cert
            <select name="cert_tier" defaultValue={cert_tier ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200">
              <option value="">Any tier</option>
              {certTiers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Cert status
            <select name="cert_status" defaultValue={cert_status ?? ""} className="mt-1 block rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200">
              <option value="">Any</option>
              {certStatuses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button type="submit" className="rounded-full bg-white/10 px-4 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Apply</button>
          <Link href={statusHref("")} className="px-2 py-1.5 text-xs text-slate-500 underline hover:text-slate-300">Clear</Link>
        </form>

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
