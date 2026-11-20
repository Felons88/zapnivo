export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { Pill } from "@/components/SupportNav";
import { equipmentLabelOr } from "@/lib/equipment";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Venue", robots: { index: false, follow: false } };
const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";

export default async function VenueDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string; detail?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const { id } = await params;
  const feedback = await searchParams;
  const db = serviceClient();
  const [vRes, orgsRes, kiosksRes] = db ? await Promise.all([
    db.from("venues").select("id,name,city,state,published,organization_id,lat,lng,equipment_category,address").eq("id", id).maybeSingle(),
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
    db.from("kiosks").select("station_id,state,test_mode").eq("venue_id", id),
  ]) : [{ data: null }, { data: null }, { data: null }];
  const v = vRes.data as { id: string; name: string; city: string; state: string; published: boolean; organization_id: string | null; lat: number | null; lng: number | null; equipment_category: string | null; address: string | null } | null;
  if (!v) notFound();
  const orgRows = (orgsRes.data ?? []) as { id: string; name: string }[];
  const kiosks = (kiosksRes.data ?? []) as { station_id: string; state: string; test_mode: boolean | null }[];
  const back = `/admin/partners/venues/${v.id}`;

  return (
    <AdminGate title={v.name} nav="partners">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/admin/partners" className="text-sm font-bold text-graphite hover:text-ink">← Partners</Link>
          <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · venue record</span>
        </div>
        {(feedback.result || feedback.detail) && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-[#635bff] text-white"}`}>{feedback.detail ?? "Saved."}</div>}

        <section className="overflow-hidden rounded-2xl bg-[#142126] text-white shadow-sm">
          <div className="border-b border-white/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#635bff]">Venue</div>
          <div className="flex flex-wrap items-start justify-between gap-4 p-4 ">
            <div>
              <p className="eyebrow text-[#635bff]">{equipmentLabelOr(v.equipment_category, "unclassified")}</p>
              <h2 className="mt-1 font-display text-xl font-bold tracking-tight">{v.name}</h2>
              <p className="mt-1 text-sm text-[#b7c8c2]">{v.address ? `${v.address}, ` : ""}{v.city}, {v.state}</p>
              {kiosks.length > 0 && <p className="mt-2 text-xs text-[#b7c8c2]">Kiosks: {kiosks.map((k) => `${k.station_id} (${k.state}${k.test_mode ? " · test" : ""})`).join(" · ")}</p>}
            </div>
            <Pill tone={v.published ? "lime" : "mist"}>{v.published ? "published" : "unpublished"}</Pill>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Owner organization</h3>
            <form method="post" action="/api/admin/partners" className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="action" value="assign_venue_org" /><input type="hidden" name="venue_id" value={v.id} /><input type="hidden" name="back" value={back} />
              <select name="organization_id" defaultValue={v.organization_id ?? ""} className={input}><option value="">— unassigned —</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
              <button className="min-h-10 rounded-full bg-[#0a2540] px-4 text-xs font-bold text-white">Save owner</button>
            </form>
            <p className="mt-3 text-xs text-graphite">The org's owners see this venue's earnings in their portal.</p>
          </div>

          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Map settings</h3>
            <form method="post" action="/api/admin/partners" className="mt-3 space-y-3">
              <input type="hidden" name="action" value="save_venue_map" /><input type="hidden" name="venue_id" value={v.id} /><input type="hidden" name="back" value={back} />
              <div className="flex gap-3">
                <label className="flex-1 text-xs font-bold">Latitude<input name="lat" type="number" step="any" min="-90" max="90" defaultValue={v.lat ?? ""} placeholder="45.5602" className="mt-1 w-full min-h-10 rounded-lg border border-silver/70 px-3 text-sm font-normal" /></label>
                <label className="flex-1 text-xs font-bold">Longitude<input name="lng" type="number" step="any" min="-180" max="180" defaultValue={v.lng ?? ""} placeholder="-94.1625" className="mt-1 w-full min-h-10 rounded-lg border border-silver/70 px-3 text-sm font-normal" /></label>
              </div>
              <label className="flex items-center gap-2 text-sm"><input name="published" type="checkbox" value="yes" defaultChecked={v.published} />Publish on the public map</label>
              <p className="text-[11px] text-graphite">Showing publicly also requires verified coordinates and an installed kiosk reporting online.</p>
              <button className="min-h-10 rounded-full bg-[#0a2540] px-4 text-xs font-bold text-white">Save map settings</button>
            </form>
          </div>
        </section>
      </div>
    </AdminGate>
  );
}
