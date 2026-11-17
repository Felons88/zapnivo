"use client";
import { useMemo, useState } from "react";
import type { Station } from "@/lib/stations";
import { track } from "@/lib/analytics";
import { inputCls } from "./forms";
import { NetworkMap, type MapFocus } from "./NetworkMap";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const TYPE_LABEL: Record<string, string> = {
  bar: "Bar", restaurant: "Restaurant", cafe: "Café", nightclub: "Nightclub", brewery: "Brewery",
  shopping_mall: "Mall", retail: "Retail", convenience_store: "Convenience", gas_station: "Gas station",
  hotel: "Hotel", gym: "Gym", entertainment: "Entertainment", event_venue: "Events", campus: "Campus",
  transport: "Transit", other: "Venue",
};
export const venueTypeLabel = (t: string | null) => (t ? (TYPE_LABEL[t] ?? t.replace(/_/g, " ")) : null);

const STATE_STYLE: Record<Station["station_state"], { dot: string; text: string }> = {
  available: { dot: "bg-lime", text: "text-forest" },
  offline: { dot: "bg-red-500", text: "text-red-700" },
  maintenance: { dot: "bg-amber-500", text: "text-amber-700" },
  stale: { dot: "bg-silver", text: "text-graphite" },
};

/**
 * Station locator: Mapbox map + filterable list of published venues.
 * Search geocodes a Minnesota city/ZIP (when a token exists) and flies the
 * map there; it also filters the list. Geolocation only on button press.
 * Offline/maintenance stations are shown with their real status — never as
 * available.
 */
export function Locator({ stations }: { stations: Station[] }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [focus, setFocus] = useState<MapFocus>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const types = useMemo(() => [...new Set(stations.map((s) => s.venue_type).filter((t): t is string => !!t))], [stations]);

  const needle = query.trim().toLowerCase();
  const hits = stations.filter((s) => {
    if (type && s.venue_type !== type) return false;
    if (onlyAvailable && s.station_state !== "available") return false;
    if (needle && !`${s.name} ${s.address} ${s.city} ${s.zip}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!needle) return;
    track("station_search");
    if (!TOKEN) return setMsg("Map search is temporarily unavailable. Showing matching stations below.");
    try {
      const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}&country=us&bbox=-97.3,43.4,-89.4,49.5&limit=1&access_token=${TOKEN}`);
      const f = (await r.json()).features?.[0];
      if (!f) return setMsg("We couldn't find that place in Minnesota.");
      const [lng, lat] = f.geometry.coordinates;
      setFocus({ lng, lat, zoom: /^\d{5}$/.test(needle) ? 11 : 10 });
      setMsg(null);
    } catch { setMsg("Search is unavailable right now."); }
  }

  const locate = () => {
    if (!("geolocation" in navigator)) return setMsg("Your browser doesn't support location sharing.");
    navigator.geolocation.getCurrentPosition(
      (p) => { setFocus({ lng: p.coords.longitude, lat: p.coords.latitude, zoom: 11 }); setMsg(stations.length ? null : "No stations are live near you yet — we're adding venues across Minnesota."); },
      () => setMsg("Location wasn't shared. You can still search by city or ZIP."),
      { timeout: 8000 },
    );
  };

  const dir = (s: Station) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${s.lat},${s.lng}`)}`;

  return (
    <div>
      <form onSubmit={search} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="station-search" className="sr-only">Search by city, ZIP, address, or venue</label>
        <input id="station-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search city, ZIP, or venue name" className={`${inputCls} max-w-md`} />
        <button type="submit" className="inline-flex min-h-12 items-center rounded-full bg-ink px-6 text-sm font-bold text-white hover:bg-graphite">Search</button>
        <button type="button" onClick={locate} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-ink/25 px-5 text-sm font-bold hover:border-ink/60">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
          Use my location
        </button>
      </form>

      {(types.length > 1 || stations.some((s) => s.station_state !== "available")) && (
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter stations">
          {types.length > 1 && (
            <>
              <button type="button" onClick={() => setType(null)}
                className={`rounded-full border px-4 py-1.5 text-xs font-bold ${type === null ? "border-ink bg-ink text-white" : "border-ink/20 text-graphite hover:border-ink/50"}`}>
                All venues
              </button>
              {types.map((t) => (
                <button key={t} type="button" onClick={() => setType(type === t ? null : t)}
                  className={`rounded-full border px-4 py-1.5 text-xs font-bold ${type === t ? "border-ink bg-ink text-white" : "border-ink/20 text-graphite hover:border-ink/50"}`}>
                  {venueTypeLabel(t)}
                </button>
              ))}
            </>
          )}
          <button type="button" onClick={() => setOnlyAvailable((v) => !v)}
            className={`rounded-full border px-4 py-1.5 text-xs font-bold ${onlyAvailable ? "border-forest bg-forest text-white" : "border-ink/20 text-graphite hover:border-ink/50"}`}>
            Open now
          </button>
        </div>
      )}
      {msg && <p className="mt-3 text-sm text-graphite" role="status">{msg}</p>}

      <NetworkMap stations={hits.filter((s) => s.station_state === "available")} focus={focus} className="mt-8 h-[460px] rounded-xl md:h-[600px]" />

      {hits.length === 0 ? (
        <div className="mt-8 rounded-xl bg-white p-8 text-center">
          <p className="font-display text-2xl font-bold">{stations.length ? "No stations match that search." : "Stations are on the way."}</p>
          <p className="mx-auto mt-2 max-w-md text-graphite">{stations.length ? "Try another city, ZIP, or category." : "Zapnivo is bringing portable charging to venues across Minnesota. Verified stations appear on the map with hours and directions as they open — we never list locations that aren't real."}</p>
          <a href="/business/apply" className="mt-5 inline-flex min-h-12 items-center rounded-full bg-lime px-6 font-bold">Request a station at your venue →</a>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {hits.map((s) => {
            const st = STATE_STYLE[s.station_state];
            return (
              <li key={s.id} className="card-hover flex flex-col rounded-xl bg-white p-6">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-lg font-bold">{s.name}</h3>
                  {s.venue_type && <span className="shrink-0 rounded-full bg-mist px-2.5 py-1 text-[11px] font-bold text-forest">{venueTypeLabel(s.venue_type)}</span>}
                </div>
                <p className="mt-1 text-sm text-graphite">{s.address}<br />{s.city}, {s.state} {s.zip}</p>
                {s.hours && <p className="mt-2 text-sm">{s.hours}</p>}
                <p className={`mt-2 flex items-center gap-2 text-sm font-bold ${st.text}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${st.dot}`} aria-hidden />
                  {s.availability}
                </p>
                {s.accessibility && <p className="mt-1 text-xs text-graphite">{s.accessibility}</p>}
                <div className="mt-4 flex items-center gap-4 pt-1 text-sm font-bold">
                  <button type="button" onClick={() => setFocus({ lng: s.lng, lat: s.lat, zoom: 14 })} className="underline">Show on map</button>
                  <a href={dir(s)} target="_blank" rel="noopener noreferrer" className="underline">Directions →</a>
                  {s.website && <a href={s.website} target="_blank" rel="noopener noreferrer" className="underline">Website</a>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
