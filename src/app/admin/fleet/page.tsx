export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/AdminCards";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Fleet", robots: { index: false, follow: false } };

const STATE_TONE = { online: "lime", offline: "red", maintenance: "gold", provisioning: "cyan", disabled: "mist" } as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function Fleet() {
  const db = serviceClient();
  const [kiosks, slots, banks, visits, events, venues, orgs] = db ? await Promise.all([
    db.from("kiosks").select("id,station_id,state,model,firmware_version,last_seen_at,installed_at,slot_count,venues(name,city,state)").order("created_at", { ascending: false }).limit(200),
    db.from("kiosk_slots").select("kiosk_id,state").limit(5000),
    db.from("power_banks").select("id,battery_pct,retired").limit(5000),
    db.from("maintenance_visits").select("id,kiosk_id,notes,visited_at,kiosks(station_id)").order("visited_at", { ascending: false }).limit(10),
    db.from("device_events").select("id,kiosk_id,event_type,occurred_at,kiosks(station_id)").order("occurred_at", { ascending: false }).limit(10),
    db.from("venues").select("id,name,city,state").order("name").limit(200),
    db.from("organizations").select("id,name").order("name").limit(200),
  ]) : [null, null, null, null, null, null, null];

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
  const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string }[];
  const orgRows = (orgs?.data ?? []) as { id: string; name: string }[];
  const inputCls = "min-h-10 rounded-lg border border-white/20 px-3 text-sm";

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

          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label="Register kiosk" className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Register a kiosk</h2>
              <form method="post" action="/api/admin/fleet" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="create_kiosk" />
                <div><label htmlFor="k-venue" className="mb-1 block text-xs font-bold">Venue (optional)</label>
                  <select id="k-venue" name="venue_id" className={inputCls}><option value="">— unassigned —</option>{venueRows.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.city}</option>)}</select></div>
                <div><label htmlFor="k-model" className="mb-1 block text-xs font-bold">Model</label><input id="k-model" name="model" className={inputCls} placeholder="ZP-8" /></div>
                <div><label htmlFor="k-slots" className="mb-1 block text-xs font-bold">Slots</label><input id="k-slots" name="slot_count" type="number" min="1" max="64" defaultValue="8" className={`${inputCls} w-20`} /></div>
                <button className="min-h-10 rounded-full bg-lime px-5 text-sm font-bold text-ink">Register</button>
              </form>
              <p className="mt-3 text-xs text-silver">A server-side station ID (ZN-…) is generated for QR codes. New kiosks start in <b>provisioning</b>.</p>
            </section>
            <section aria-label="Add venue" className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Add a venue</h2>
              <form method="post" action="/api/admin/fleet" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="create_venue" />
                <div><label htmlFor="v-name" className="mb-1 block text-xs font-bold">Name</label><input id="v-name" name="name" required className={inputCls} placeholder="Riverside Bar" /></div>
                <div><label htmlFor="v-city" className="mb-1 block text-xs font-bold">City</label><input id="v-city" name="city" required className={inputCls} placeholder="Minneapolis" /></div>
                <div><label htmlFor="v-state" className="mb-1 block text-xs font-bold">State</label><input id="v-state" name="state" required maxLength={2} className={`${inputCls} w-16`} placeholder="MN" /></div>
                <div><label htmlFor="v-org" className="mb-1 block text-xs font-bold">Owner org</label>
                  <select id="v-org" name="organization_id" className={inputCls}><option value="">— none yet —</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 rounded-full bg-lime px-5 text-sm font-bold text-ink">Add venue</button>
              </form>
              <p className="mt-3 text-xs text-silver">Venues start unpublished — set <b>published</b> in Supabase once verified live on the map.</p>
            </section>
          </div>

          <section aria-label="Stations" className="overflow-x-auto rounded-2xl border border-white/10 bg-[#181933] shadow-sm">
            <div className="border-b border-white/10 px-6 py-4"><h2 className="font-display text-lg font-bold">Stations</h2></div>
            {kioskRows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-silver">No stations registered yet. The first kiosk appears here once provisioned.</p>
            ) : (
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="border-b border-white/10 bg-white/5 text-xs uppercase tracking-wider text-silver">
                  <tr>{["Station", "Venue", "State", "Slots (ready/charge/empty/fault)", "Last seen", "Installed", "Model / FW"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {kioskRows.map((k) => {
                    const s = byKiosk.get(k.id) ?? {};
                    return (
                      <tr key={k.id} className="border-b border-white/10 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3 font-bold">{k.station_id}</td>
                        <td className="px-4 py-3">
                          <form method="post" action="/api/admin/fleet" className="flex items-center gap-2">
                            <input type="hidden" name="action" value="assign_kiosk" /><input type="hidden" name="kiosk_id" value={k.id} />
                            <select name="venue_id" defaultValue="" aria-label={`Assign ${k.station_id} to venue`} className="min-h-8 rounded-lg border border-white/20 px-2 text-xs font-semibold">
                              <option value="" disabled>{k.venues?.name ?? "— assign —"}</option>
                              {venueRows.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                            </select>
                            <button className="min-h-8 rounded-full bg-white/10 px-3 text-xs font-bold hover:bg-lime hover:text-ink">Assign</button>
                          </form>
                          {k.venues && <p className="mt-0.5 text-xs text-silver">{k.venues.name} · {k.venues.city}, {k.venues.state}</p>}
                        </td>
                        <td className="px-4 py-3"><Pill tone={STATE_TONE[k.state] ?? "mist"}>{k.state}</Pill></td>
                        <td className="px-4 py-3 text-xs font-semibold">{s.ready ?? 0} / {s.charging ?? 0} / {s.empty ?? 0} / {s.fault ?? 0}</td>
                        <td className="px-4 py-3 text-xs text-silver">{when(k.last_seen_at)}</td>
                        <td className="px-4 py-3 text-xs text-silver">{when(k.installed_at)}</td>
                        <td className="px-4 py-3 text-xs text-silver">{[k.model, k.firmware_version].filter(Boolean).join(" · ") || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label="Recent maintenance" className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Recent maintenance visits</h2>
              {visitRows.length === 0 ? <p className="mt-4 text-sm text-silver">None logged yet.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {visitRows.map((v) => <li key={v.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{v.kiosks?.[0]?.station_id ?? "—"}</b> · {v.notes ?? "visit"}</span><span className="shrink-0 text-xs text-silver">{when(v.visited_at)}</span></li>)}
                </ul>
              )}
            </section>
            <section aria-label="Device events" className="rounded-2xl border border-white/10 bg-[#181933] p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Latest device events</h2>
              {eventRows.length === 0 ? <p className="mt-4 text-sm text-silver">No hardware events yet — they stream in once kiosks are connected.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {eventRows.map((e) => <li key={e.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{e.kiosks?.[0]?.station_id ?? "—"}</b> · {e.event_type}</span><span className="shrink-0 text-xs text-silver">{when(e.occurred_at)}</span></li>)}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
