"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type KioskRef = { id: string; station_id: string | null; state: string; test_mode: boolean | null };
type Venue = {
  id: string; name: string; venue_type: string; street: string; city: string; state: string;
  zip: string | null; hours: string | null; lat: number | null; lng: number | null;
  published: boolean; organization: string | null; equipment_category: string | null;
  created_at: string; kiosks: KioskRef[];
};
type Org = { id: string; name: string };

const inputCls = "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-lime/50 focus:outline-none";
const labelCls = "mb-1 block text-[10px] font-extrabold uppercase tracking-wider text-slate-500";
const TYPES = ["Bar", "Restaurant", "Hotel", "Apartment", "Office", "Gym", "Campus", "Venue", "Other"];

export function VenuesManager({ venues, orgs }: { venues: Venue[]; orgs: Org[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    const fd = new FormData(e.currentTarget);
    const str = (k: string) => { const v = String(fd.get(k) ?? "").trim(); return v === "" ? undefined : v; };
    try {
      const res = await fetch("/api/system/venues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: str("name"), venue_type: str("venue_type"), street: str("street"),
          city: str("city"), state: str("state"), zip: str("zip"), hours: str("hours"),
          lat: str("lat") === undefined ? undefined : Number(str("lat")),
          lng: str("lng") === undefined ? undefined : Number(str("lng")),
          organization_id: str("organization_id"),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      setNotice("Venue added as unpublished.");
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } finally { setBusy(false); }
  };

  const togglePublish = async (v: Venue) => {
    setPublishing(v.id); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/system/venues", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: v.id, published: !v.published }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      setNotice(v.published ? `"${v.name}" unpublished — removed from public listings.` : `"${v.name}" published — eligible for the public map once a live kiosk is bound.`);
      router.refresh();
    } finally { setPublishing(null); }
  };

  return (
    <div className="space-y-6">
      {/* Add venue */}
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-6">
        <h2 className="text-sm font-semibold text-slate-200">Add a venue</h2>
        <p className="mt-1 text-[11px] text-slate-500">Venues start unpublished. Requires <code className="font-mono">system.kiosks.manage</code>.</p>
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><label className={labelCls} htmlFor="v-name">Name *</label><input id="v-name" name="name" required maxLength={160} className={inputCls} placeholder="Riverside Bar" /></div>
          <div><label className={labelCls} htmlFor="v-type">Type *</label>
            <input id="v-type" name="venue_type" required maxLength={60} className={inputCls} placeholder="Bar" list="venue-types" />
            <datalist id="venue-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
          <div><label className={labelCls} htmlFor="v-org">Owner org</label>
            <select id="v-org" name="organization_id" className={inputCls}>
              <option value="">— none —</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2"><label className={labelCls} htmlFor="v-street">Street *</label><input id="v-street" name="street" required maxLength={200} className={inputCls} placeholder="123 Main St" /></div>
          <div><label className={labelCls} htmlFor="v-hours">Hours</label><input id="v-hours" name="hours" maxLength={200} className={inputCls} placeholder="Mon–Fri 7a–9p" /></div>
          <div><label className={labelCls} htmlFor="v-city">City *</label><input id="v-city" name="city" required maxLength={120} className={inputCls} placeholder="Minneapolis" /></div>
          <div><label className={labelCls} htmlFor="v-state">State *</label><input id="v-state" name="state" required minLength={2} maxLength={2} className={inputCls} placeholder="MN" /></div>
          <div><label className={labelCls} htmlFor="v-zip">ZIP</label><input id="v-zip" name="zip" maxLength={10} className={inputCls} placeholder="55401" /></div>
          <div><label className={labelCls} htmlFor="v-lat">Latitude</label><input id="v-lat" name="lat" type="number" step="any" min={-90} max={90} className={inputCls} placeholder="44.9778" /></div>
          <div><label className={labelCls} htmlFor="v-lng">Longitude</label><input id="v-lng" name="lng" type="number" step="any" min={-180} max={180} className={inputCls} placeholder="-93.2650" /></div>
          <div className="flex items-end">
            <button disabled={busy} className="h-10 w-full rounded-lg bg-lime px-4 text-sm font-bold text-ink transition-colors hover:bg-[#e6ffa8] disabled:opacity-50">
              {busy ? "Adding…" : "Add venue"}
            </button>
          </div>
        </form>
        {error && <p className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}
        {notice && <p className="mt-3 rounded-lg border border-lime/20 bg-lime/[0.06] px-3 py-2 text-xs text-lime">{notice}</p>}
      </section>

      {/* Venue list */}
      <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.03]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-200">All venues <span className="font-mono text-[10px] text-slate-500">({venues.length})</span></h2>
        </div>
        {venues.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-500">No venues yet — add the first one above.</p>
        ) : (
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5">Venue</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5">Owner</th>
                <th className="px-4 py-2.5">Stations</th>
                <th className="px-4 py-2.5">Map</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {venues.map((v) => (
                <tr key={v.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <p className="font-semibold text-slate-200">{v.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{v.street}{v.zip ? `, ${v.zip}` : ""}</p>
                    {v.hours && <p className="mt-0.5 text-[11px] text-slate-500">{v.hours}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{v.venue_type}</td>
                  <td className="px-4 py-2.5 text-slate-400">{v.city}, {v.state}</td>
                  <td className="px-4 py-2.5 text-slate-400">{v.organization ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {v.kiosks.length === 0 ? <span className="text-slate-600">none</span> : (
                      <div className="space-y-0.5">
                        {v.kiosks.map((k) => (
                          <p key={k.id} className="font-mono text-[11px] text-slate-300">
                            {k.station_id ?? k.id.slice(0, 8)}
                            <span className="ml-1 text-slate-500">· {k.state}{k.test_mode ? " · test" : ""}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">
                    {v.lat != null && v.lng != null ? (
                      <a className="text-sky-400 hover:underline" href={`https://www.google.com/maps?q=${v.lat},${v.lng}`} target="_blank" rel="noreferrer">{Number(v.lat).toFixed(4)}, {Number(v.lng).toFixed(4)}</a>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${v.published ? "bg-lime/15 text-lime ring-lime/30" : "bg-slate-400/10 text-slate-400 ring-slate-400/25"}`}>
                      {v.published ? "published" : "unpublished"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      disabled={publishing === v.id}
                      onClick={() => togglePublish(v)}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold ring-1 transition-colors disabled:opacity-50 ${v.published ? "bg-white/[0.06] text-slate-300 ring-white/15 hover:bg-white/10" : "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25"}`}
                    >
                      {publishing === v.id ? "…" : v.published ? "Unpublish" : "Publish"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
