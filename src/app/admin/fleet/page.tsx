export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { FleetStationGrid, type FleetStation } from "@/components/FleetStationGrid";
import { serviceClient } from "@/lib/supabase";
import { heartbeatStale } from "@/lib/kiosk/heartbeat";

export const metadata: Metadata = { title: "Fleet", robots: { index: false, follow: false } };

const FILTERS = ["all", "attention", "online", "offline", "maintenance", "provisioning", "disabled"] as const;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export default async function Fleet({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; q?: string; state?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const [kiosks, slots, banks, visits, events, venues, orgs] = db ? await Promise.all([
    db.from("kiosks").select("id,station_id,venue_id,state,model,firmware_version,last_seen_at,installed_at,slot_count,venues(name,city,state)").order("created_at", { ascending: false }).limit(200),
    db.from("kiosk_slots").select("kiosk_id,state").limit(5000),
    db.from("power_banks").select("id,battery_pct,retired").limit(5000),
    db.from("maintenance_visits").select("id,kiosk_id,notes,visited_at,kiosks(station_id)").order("visited_at", { ascending: false }).limit(10),
    db.from("device_events").select("id,kiosk_id,event_type,occurred_at,kiosks(station_id)").order("occurred_at", { ascending: false }).limit(10),
    db.from("venues").select("id,name,city,state").order("name").limit(200),
    db.from("organizations").select("id,name").order("name").limit(200),
  ]) : [null, null, null, null, null, null, null];

  const kioskRows = (kiosks?.data ?? []) as unknown as FleetStation[];
  const q = (feedback.q ?? "").trim().toLowerCase().slice(0, 80);
  const state = FILTERS.find((filter) => filter === feedback.state) ?? "all";
  const visibleRows = kioskRows.filter((k) => {
    const stale = k.state === "online" && heartbeatStale(k.last_seen_at);
    const stateMatch = state === "all" || (state === "attention" ? stale || k.state === "offline" || k.state === "maintenance" : k.state === state);
    return stateMatch && (!q || [k.station_id, k.venues?.name, k.venues?.city, k.model].some((v) => v?.toLowerCase().includes(q)));
  });
  const attentionCount = kioskRows.filter((k) => k.state === "offline" || k.state === "maintenance" || (k.state === "online" && heartbeatStale(k.last_seen_at))).length;
  const slotRows = (slots?.data ?? []) as { kiosk_id: string; state: string }[];
  const byKiosk = new Map<string, Record<string, number>>();
  for (const s of slotRows) {
    const m = byKiosk.get(s.kiosk_id) ?? {};
    m[s.state] = (m[s.state] ?? 0) + 1;
    byKiosk.set(s.kiosk_id, m);
  }
  const bankRows = (banks?.data ?? []) as { id: string; battery_pct: number | null; retired: boolean }[];
  const live = bankRows.filter((b) => !b.retired);
  const visitRows = (visits?.data ?? []) as unknown as { id: string; notes: string | null; visited_at: string; kiosks: { station_id: string } | null }[];
  const eventRows = (events?.data ?? []) as unknown as { id: number; event_type: string; occurred_at: string; kiosks: { station_id: string } | null }[];
  const venueRows = (venues?.data ?? []) as { id: string; name: string; city: string; state: string }[];
  const orgRows = (orgs?.data ?? []) as { id: string; name: string }[];
  const criticalError = !!(kiosks?.error || slots?.error || banks?.error);
  const inputCls = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";
  const filterHref = (next: string) => "/admin/fleet?state=" + next + (q ? "&q=" + encodeURIComponent(q) : "") + "#fleet-stations";

  return (
    <AdminGate title="Fleet" nav="fleet">
      {!db || criticalError ? (
        <EmptyCard title="Fleet data unavailable">{criticalError ? "Station or inventory data could not load. Try again shortly." : "Connect Supabase to see live station, slot and device data."}</EmptyCard>
      ) : (
        <div className="space-y-4">
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[#142126] p-4 text-white ">
            <div><p className="eyebrow text-[#635bff]">Network operations</p><h2 className="mt-1 text-xl font-bold tracking-tight">Know what needs attention.</h2><p className="mt-1 max-w-2xl text-xs text-[#b7c8c2]">Monitor live station state, slot readiness and recent device activity. Open a station to investigate and act.</p></div>
            <div className="flex gap-2"><a href="#fleet-stations" className="rounded-lg bg-[#635bff] px-4 py-2.5 text-sm font-bold text-white">View stations ↓</a><a href="#fleet-setup" className="rounded-lg border border-white/25 px-4 py-2.5 text-sm font-bold hover:bg-white/10">Setup tools</a></div>
          </section>
          {feedback.result && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-[#635bff] text-white"}`}>
            {feedback.result === "created" ? `Kiosk ${feedback.detail ?? ""} registered with its slot records. It is provisioning until connected hardware confirms status.` : feedback.result === "venue" ? "Venue added as unpublished." : feedback.result === "assigned" ? "Kiosk assignment saved." : feedback.result === "installed" ? "Physical installation recorded. The station remains nonpublic until its device is online and its venue is published." : feedback.detail ?? "The fleet action failed."}
          </div>}
          <section aria-label="Fleet at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Stations" value={kioskRows.length} sub={`${kioskRows.filter((k) => k.state === "online").length} online`} />
            <Metric label="Needs attention" value={attentionCount} sub="Offline, maintenance or stale" />
            <Metric label="Slots" value={slotRows.length} sub={`${slotRows.filter((s) => s.state === "ready").length} ready · ${slotRows.filter((s) => s.state === "fault").length} fault`} />
            <Metric label="Power banks" value={live.length} sub={`${bankRows.length - live.length} retired`} />
          </section>

          <section id="fleet-stations" aria-label="Stations" className="scroll-mt-24 overflow-hidden rounded-2xl border border-[#e3e8ee] bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3e8ee] px-4 py-3"><div><p className="eyebrow text-forest">Station directory</p><h2 className="mt-1 font-display text-xl font-bold">Fleet status</h2></div><p className="text-xs text-graphite">Showing {visibleRows.length} of {kioskRows.length}</p></div>
            <div className="space-y-3 border-b border-[#e3e8ee] px-5 py-4">
              <form action="/admin/fleet" className="flex max-w-md gap-2"><input type="hidden" name="state" value={state} /><input name="q" defaultValue={feedback.q} aria-label="Search stations" placeholder="Search station, venue or model…" className="min-h-10 min-w-0 flex-1 rounded-lg border border-silver/70 px-3 text-sm" /><button className="rounded-lg bg-[#0a2540] px-4 text-xs font-bold text-white">Search</button></form>
              <nav aria-label="Station status filters" className="flex gap-2 overflow-x-auto">{FILTERS.map((filter) => <Link key={filter} href={filterHref(filter)} className={"shrink-0 rounded-full px-3 py-1.5 text-xs font-bold " + (state === filter ? "bg-[#635bff] text-white" : "bg-[#f2f5f1] text-graphite hover:bg-[#eef1f5]")}>{filter === "all" ? "All stations" : filter}</Link>)}</nav>
            </div>
            {kioskRows.length === 0 ? (
              <p className="px-4 py-8 text-sm text-graphite">No stations registered yet. The first kiosk appears here once provisioned.</p>
            ) : visibleRows.length === 0 ? (
              <p className="px-4 py-8 text-sm text-graphite">No stations match these filters. Search by station ID or choose another status.</p>
            ) : (
              <FleetStationGrid rows={visibleRows} slots={byKiosk} venues={venueRows} />
            )}
          </section>

          <details id="fleet-setup" className="rounded-2xl border border-[#e3e8ee] bg-white p-5">
            <summary className="cursor-pointer text-sm font-bold">Station setup · register kiosk or add venue <span className="float-right text-graphite">⌄</span></summary>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <section id="register-kiosk" aria-label="Register kiosk" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Register a kiosk</h2>
              <form method="post" action="/api/admin/fleet" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="create_kiosk" />
                <div><label htmlFor="k-venue" className="mb-1 block text-xs font-bold">Venue (optional)</label>
                  <select id="k-venue" name="venue_id" className={inputCls}><option value="">— unassigned —</option>{venueRows.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.city}</option>)}</select></div>
                <div><label htmlFor="k-model" className="mb-1 block text-xs font-bold">Model</label><input id="k-model" name="model" className={inputCls} placeholder="ZP-8" /></div>
                <div><label htmlFor="k-slots" className="mb-1 block text-xs font-bold">Slots</label><input id="k-slots" name="slot_count" type="number" min="1" max="64" defaultValue="8" className={`${inputCls} w-20`} /></div>
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Register</button>
              </form>
              <p className="mt-3 text-xs text-graphite">A unique station ID and numbered empty slots are created together. New kiosks stay in <b>provisioning</b> until real hardware is connected.</p>
            </section>
            <section aria-label="Add venue" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Add a venue</h2>
              <form method="post" action="/api/admin/fleet" className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="action" value="create_venue" />
                <div><label htmlFor="v-name" className="mb-1 block text-xs font-bold">Name</label><input id="v-name" name="name" required className={inputCls} placeholder="Riverside Bar" /></div>
                <div><label htmlFor="v-type" className="mb-1 block text-xs font-bold">Type</label><input id="v-type" name="venue_type" required className={inputCls} placeholder="Bar" /></div>
                <div><label htmlFor="v-street" className="mb-1 block text-xs font-bold">Street</label><input id="v-street" name="street" required className={inputCls} placeholder="123 Main St" /></div>
                <div><label htmlFor="v-city" className="mb-1 block text-xs font-bold">City</label><input id="v-city" name="city" required className={inputCls} placeholder="Minneapolis" /></div>
                <div><label htmlFor="v-state" className="mb-1 block text-xs font-bold">State</label><input id="v-state" name="state" required maxLength={2} className={`${inputCls} w-16`} placeholder="MN" /></div>
                <div><label htmlFor="v-zip" className="mb-1 block text-xs font-bold">ZIP</label><input id="v-zip" name="zip" className={`${inputCls} w-24`} placeholder="55401" /></div>
                <div><label htmlFor="v-org" className="mb-1 block text-xs font-bold">Owner org</label>
                  <select id="v-org" name="organization_id" className={inputCls}><option value="">— none yet —</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 rounded-full bg-[#0a2540] px-5 text-sm font-bold text-white">Add venue</button>
              </form>
              <p className="mt-3 text-xs text-graphite">Venues start unpublished. Link an owner organization on <Link href="/admin/partners" className="font-bold text-forest underline">Partners</Link>; add verified coordinates and publish only after installation and live device verification.</p>
            </section>
          </div>
          </details>

          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-label="Recent maintenance" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Recent maintenance visits</h2>
              {visitRows.length === 0 ? <p className="mt-4 text-sm text-graphite">None logged yet.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {visitRows.map((v) => <li key={v.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{v.kiosks?.station_id ?? "—"}</b> · {v.notes ?? "visit"}</span><span className="shrink-0 text-xs text-graphite">{when(v.visited_at)}</span></li>)}
                </ul>
              )}
            </section>
            <section aria-label="Device events" className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <h2 className="font-display text-lg font-bold">Latest device events</h2>
              {eventRows.length === 0 ? <p className="mt-4 text-sm text-graphite">No hardware events yet — they stream in once kiosks are connected.</p> : (
                <ul className="mt-4 space-y-2 text-sm">
                  {eventRows.map((e) => <li key={e.id} className="flex items-baseline justify-between gap-4"><span className="truncate"><b>{e.kiosks?.station_id ?? "—"}</b> · {e.event_type}</span><span className="shrink-0 text-xs text-graphite">{when(e.occurred_at)}</span></li>)}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </AdminGate>
  );
}
