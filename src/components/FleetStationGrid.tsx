import Link from "next/link";
import { Pill } from "@/components/SupportNav";
import { heartbeatStale } from "@/lib/kiosk/heartbeat";

export type FleetStation = {
  id: string;
  station_id: string;
  venue_id: string | null;
  state: "online" | "offline" | "maintenance" | "provisioning" | "disabled";
  model: string | null;
  firmware_version: string | null;
  last_seen_at: string | null;
  installed_at: string | null;
  slot_count: number;
  venues: { name: string; city: string; state: string } | null;
};
type Venue = { id: string; name: string; city: string; state: string };
const STATE_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export function FleetStationGrid({ rows, slots, venues }: { rows: FleetStation[]; slots: Map<string, Record<string, number>>; venues: Venue[] }) {
  return <div className="grid gap-4 p-5 xl:grid-cols-2">
    {rows.map((station) => {
      const s = slots.get(station.id) ?? {};
      const total = Math.max(1, station.slot_count);
      const stale = station.state === "online" && heartbeatStale(station.last_seen_at);
      const used = Object.values(s).reduce((a, b) => a + b, 0);
      return <article key={station.id} className="min-w-0 rounded-2xl border border-[#dfe7dd] bg-[#fbfcfa] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow text-forest">Station</p><Link href={"/admin/fleet/" + station.station_id} className="mt-1 block text-xl font-bold tracking-tight hover:underline">{station.station_id} ↗</Link><p className="mt-1 text-sm text-graphite">{station.venues ? station.venues.name + " · " + station.venues.city + ", " + station.venues.state : "No venue assigned"}</p></div>
          <div className="flex gap-1.5"><Pill tone={STATE_TONE[station.state] ?? "mist"}>{station.state}</Pill>{stale && <Pill tone="gold">Stale heartbeat</Pill>}</div>
        </div>
        <div className="mt-5 rounded-xl border border-mist bg-white p-4">
          <div className="flex items-center justify-between"><p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Slot readiness</p><p className="text-sm font-bold">{s.ready ?? 0} ready / {station.slot_count}</p></div>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-mist" role="img" aria-label={String(s.ready ?? 0) + " ready, " + String(s.charging ?? 0) + " charging, " + String(s.fault ?? 0) + " fault of " + station.slot_count + " slots"}>
            <span className="bg-[#8fbf46]" style={{ width: (100 * (s.ready ?? 0) / total) + "%" }} />
            <span className="bg-cyan" style={{ width: (100 * (s.charging ?? 0) / total) + "%" }} />
            <span className="bg-red-400" style={{ width: (100 * (s.fault ?? 0) / total) + "%" }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-graphite"><span>{s.charging ?? 0} charging</span><span>{s.empty ?? 0} empty</span><span>{s.fault ?? 0} fault</span><span>{used} of {station.slot_count} reported</span></div>
        </div>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          <div><dt className="font-bold uppercase tracking-wider text-graphite">Last seen</dt><dd className="mt-1 font-semibold">{when(station.last_seen_at)}</dd></div>
          <div><dt className="font-bold uppercase tracking-wider text-graphite">Installed</dt><dd className="mt-1 font-semibold">{when(station.installed_at)}</dd></div>
          <div><dt className="font-bold uppercase tracking-wider text-graphite">Model</dt><dd className="mt-1 font-semibold">{station.model ?? "—"}</dd></div>
          <div><dt className="font-bold uppercase tracking-wider text-graphite">Firmware</dt><dd className="mt-1 font-semibold">{station.firmware_version ?? "—"}</dd></div>
        </dl>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-mist pt-4">
          <Link href={"/admin/fleet/" + station.station_id} className="rounded-lg bg-ink px-4 py-2 text-xs font-bold text-white">Open station →</Link>
        </div>
        <details className="group mt-3"><summary className="cursor-pointer list-none rounded-lg border border-mist bg-white px-4 py-2 text-xs font-bold [&::-webkit-details-marker]:hidden">Assignment &amp; installation ⌄</summary>
            <div className="mt-2 rounded-xl border border-mist bg-white p-4">
              <form method="post" action="/api/admin/fleet" className="space-y-2"><input type="hidden" name="action" value="assign_kiosk" /><input type="hidden" name="kiosk_id" value={station.id} /><label htmlFor={"venue-" + station.id} className="block text-xs font-bold">Assigned venue</label><select id={"venue-" + station.id} name="venue_id" defaultValue={station.venue_id ?? ""} className="min-h-10 w-full rounded-lg border border-silver/70 px-2 text-sm"><option value="">Unassigned</option>{venues.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.city}</option>)}</select><button className="rounded-lg bg-lime px-4 py-2 text-xs font-bold">Save assignment</button></form>
              {!station.installed_at && station.venue_id && <form method="post" action="/api/admin/fleet" className="mt-4 border-t border-mist pt-4"><input type="hidden" name="action" value="record_installation" /><input type="hidden" name="kiosk_id" value={station.id} /><label className="flex gap-2 text-xs"><input type="checkbox" name="confirmed" value="yes" required />Physically installed at the assigned venue</label><button className="mt-3 rounded-lg border border-silver/70 px-4 py-2 text-xs font-bold">Record installation</button></form>}
            </div>
        </details>
      </article>;
    })}
  </div>;
}
