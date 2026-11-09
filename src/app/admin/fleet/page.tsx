export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Fleet", robots: { index: false, follow: false } };

const STATE_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function Fleet() {
  const db = serviceClient();
  const [kiosks, slots, banks, visits, events] = db ? await Promise.all([
    db.from("kiosks").select("id,station_id,state,model,firmware_version,last_seen_at,installed_at,slot_count,venues(name,city,state)").order("created_at", { ascending: false }).limit(200),
    db.from("kiosk_slots").select("kiosk_id,state").limit(5000),
    db.from("power_banks").select("id,battery_pct,retired").limit(5000),
    db.from("maintenance_visits").select("id,kiosk_id,notes,visited_at,kiosks(station_id)").order("visited_at", { ascending: false }).limit(10),
    db.from("device_events").select("id,kiosk_id,event_type,occurred_at,kiosks(station_id)").order("occurred_at", { ascending: false }).limit(10),
  ]) : [null, null, null, null, null];

  type Kiosk = { id: string; station_id: string; state: keyof typeof STATE_TONE; model: string | null; firmware_version: string | null; last_seen_at: string | null; installed_at: string | null; slot_count: number; venues: { name: string; city: string; state: string } | null };
  const kioskRows = (kiosks?.data ?? []) as unknown as Kiosk[];
  const slotRows = (slots?.data ?? []) as { kiosk_id: string; state: string }[];
  const byKiosk = new Map<string, Record<string, number>>();
  for (const s of slotRows) {
    const m = byKiosk.get(s.kiosk_id) ?? {};
    m[s.state] = (m[s.state] ?? 0) + 1;
    byKiosk.set(s.kiosk_id, m);
  }
  const bankRows = (banks?.data ?? []) as { id: string; battery_pct: number | null; retired: boolean }[];
  const live = bankRows.filter((b) => !b.retired);
  const visitRows = (visits?.data ?? []) as unknown as { id: string; notes: string | null; visited_at: string; kiosks: { station_id: string }[] | null }[];
  const eventRows = (events?.data ?? []) as unknown as { id: number; event_type: string; occurred_at: string; kiosks: { station_id: string }[] | null }[];

  return (
    <AdminGate title="Fleet" nav="fleet">
      {!db ? (
        <EmptyCard title="Fleet data not connected">Connect Supabase to see live station, slot and device data.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <section aria-label="Fleet at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Stations" value={kioskRows.length} sub={`${kioskRows.filter((k) => k.state === "online").length} online`} />
            <Metric label="Slots" value={slotRows.length} sub={`${slotRows.filter((s) => s.state === "ready").length} ready · ${slotRows.filter((s) => s.state === "fault").length} fault`} />
            <Metric label="Power banks" value={live.length} sub={`${bankRows.length - live.length} retired`} />
            <Metric label="Maintenance visits" value={visitRows.length} sub="Most recent shown below" />
          </section>

          <section aria-label="Stations" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Stations</h2></div>
            {kioskRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No stations registered yet. The first kiosk appears here once provisioned.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Station", "Venue", "State", "Slots (ready/charge/empty/fault)", "Last seen", "Installed", "Model / FW"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {kioskRows.map((k) => {
                    const s = byKiosk.get(k.id) ?? {};
                    return (
                      <tr key={k.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3 font-bold">{k.station_id}</td>
                        <td className="px-4 py-3"><p className="font-semibold">{k.venues?.name ?? "—"}</p><p className="text-xs text-graphite">{k.venues ? `${k.venues.city}, ${k.venues.state}` : ""}</p></td>
                        <td className="px-4 py-3"><Pill tone={STATE_TONE[k.state] ?? "mist"}>{k.state}</Pill></td>
                        <td className="px-4 py-3 text-xs font-semibold">{s.ready ?? 0} / {s.charging ?? 0} / {s.empty ?? 0} / {s.fault ?? 0}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(k.last_seen_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(k.installed_at)}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{[k.model, k.firmware_version].filter(Boolean).join(" · ") || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label="Recent maintenance" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Recent maintenance visits</h2>
              {visitRows.length === 0 ? <p className="mt-4 text-sm text-graphite">None logged yet.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {visitRows.map((v) => <li key={v.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{v.kiosks?.[0]?.station_id ?? "—"}</b> · {v.notes ?? "visit"}</span><span className="shrink-0 text-xs text-graphite">{when(v.visited_at)}</span></li>)}
                </ul>
              )}
            </section>
            <section aria-label="Device events" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Latest device events</h2>
              {eventRows.length === 0 ? <p className="mt-4 text-sm text-graphite">No hardware events yet — they stream in once kiosks are connected.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {eventRows.map((e) => <li key={e.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{e.kiosks?.[0]?.station_id ?? "—"}</b> · {e.event_type}</span><span className="shrink-0 text-xs text-graphite">{when(e.occurred_at)}</span></li>)}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
