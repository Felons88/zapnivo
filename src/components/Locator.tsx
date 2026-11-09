"use client";
import { useState } from "react";
import type { Station } from "@/lib/stations";
import { track } from "@/lib/analytics";
import { inputCls } from "./forms";
import { NetworkMap, type MapFocus } from "./NetworkMap";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/**
 * Station locator: Mapbox map + list. Search geocodes a Minnesota city/ZIP (when a Mapbox token
 * exists) and flies the map there; it also filters the list. Geolocation only on button press.
 */
export function Locator({ stations }: { stations: Station[] }) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<MapFocus>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const hits = needle ? stations.filter((s) => `${s.name} ${s.address} ${s.city} ${s.zip}`.toLowerCase().includes(needle)) : stations;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!needle) return;
    track("station_search");
    if (!TOKEN) return setMsg("Map search needs a Mapbox token. Showing list matches only.");
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

  return (
    <div>
      <form onSubmit={search} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="station-search" className="sr-only">Search by city or ZIP</label>
        <input id="station-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a Minnesota city or ZIP code" className={`${inputCls} max-w-md`} />
        <button type="submit" className="inline-flex min-h-12 items-center rounded-full bg-ink px-6 text-sm font-bold text-white hover:bg-graphite">Search</button>
        <button type="button" onClick={locate} className="inline-flex min-h-12 items-center gap-2 rounded-full border border-ink/25 px-5 text-sm font-bold hover:border-ink/60">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
          Use my location
        </button>
      </form>
      {msg && <p className="mt-3 text-sm text-graphite" role="status">{msg}</p>}

      <NetworkMap stations={stations} focus={focus} className="mt-8 h-[460px] rounded-xl md:h-[600px]" />

      {hits.length === 0 ? (
        <div className="mt-8 rounded-xl bg-white p-8 text-center">
          <p className="font-display text-2xl font-bold">{stations.length ? "No stations match that search." : "Stations are on the way."}</p>
          <p className="mx-auto mt-2 max-w-md text-graphite">{stations.length ? "Try another city or ZIP." : "Zapnivo is bringing portable charging to venues across Minnesota. Verified stations appear on the map with hours and directions as they open — we never list locations that aren't real."}</p>
          <a href="/business/apply" className="mt-5 inline-flex min-h-12 items-center rounded-full bg-lime px-6 font-bold">Request a station at your venue →</a>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {hits.map((s) => (
            <li key={s.id} className="card-hover rounded-xl bg-white p-6">
              <h3 className="text-lg font-bold">{s.name}</h3>
              <p className="mt-1 text-sm text-graphite">{s.address}<br />{s.city}, {s.state} {s.zip}</p>
              {s.hours && <p className="mt-2 text-sm">{s.hours}</p>}
              {s.availability && <p className="mt-2 text-sm font-bold">{s.availability}</p>}
              <button type="button" onClick={() => setFocus({ lng: s.lng, lat: s.lat, zoom: 14 })} className="mt-3 text-sm font-bold underline">Show on map</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
