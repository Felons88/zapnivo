"use client";
import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap } from "mapbox-gl";
import { MINNESOTA_CENTER, type Station } from "@/lib/stations";

export type MapFocus = { lng: number; lat: number; zoom?: number } | null;

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Mapbox GL map of Minnesota with a lime pin per live station.
 * Pins come ONLY from `stations` (real, published venues). With zero stations the map shows
 * the state with no pins and an overlay explaining that stations are on the way.
 * Mapbox is loaded lazily on the client; without a token a clear fallback is shown.
 */
export function NetworkMap({ stations, focus = null, className = "", interactive = true }: { stations: Station[]; focus?: MapFocus; className?: string; interactive?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!TOKEN || !box.current) return;
    let cancelled = false;
    let map: MapboxMap | undefined;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const start = () => {
      if (started || cancelled) return;
      started = true;
      io?.disconnect();
      void init();
    };
    const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) start(); },
      { rootMargin: "200px" },
    );
    io?.observe(box.current);
    const init = async () => {
      try {
        const mapboxgl = (await import("mapbox-gl")).default;
        await import("mapbox-gl/dist/mapbox-gl.css");
        if (cancelled || !box.current) return;
        mapboxgl.accessToken = TOKEN;
        map = new mapboxgl.Map({
          container: box.current,
          style: "mapbox://styles/mapbox/dark-v11",
          center: MINNESOTA_CENTER,
          zoom: window.innerWidth < 768 ? 4.6 : 5.3,
          interactive,
          attributionControl: false,
          cooperativeGestures: true,
        });
        mapRef.current = map;
        map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
        if (interactive) map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
        loadTimeout = setTimeout(() => { if (!cancelled) setStatus("error"); }, 15000);
        map.on("load", () => {
          clearTimeout(loadTimeout);
          if (!cancelled) setStatus("ready");
        });
        map.on("error", (e) => {
          const code = (e.error as { status?: number })?.status;
          if (!cancelled && (code === 401 || code === 403)) setStatus("error");
        });

        for (const s of stations) {
          const el = document.createElement("button");
          el.type = "button";
          el.setAttribute("aria-label", `Zapnivo station: ${s.name}`);
          el.className = "relative grid h-10 w-10 place-items-center";
          el.innerHTML = `<span class="pulse-ring absolute inset-0 rounded-full bg-[#D9FF73]/60"></span><span class="relative grid h-9 w-9 place-items-center rounded-full border-2 border-[#11122B] bg-[#D9FF73] shadow-lg"><svg width="16" height="16" viewBox="0 0 24 24"><path d="M13 2 5 14h6l-2 8 10-12h-6l2-8Z" fill="#11122B"/></svg></span>`;
          const dir = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${s.address}, ${s.city}, ${s.state} ${s.zip}`)}`;
          const popup = new mapboxgl.Popup({ offset: 24, closeButton: false }).setHTML(
            `<strong>${esc(s.name)}</strong><br/><span style="font-size:13px;color:#555">${esc(s.address)}, ${esc(s.city)}</span>${s.hours ? `<br/><span style="font-size:12px">${esc(s.hours)}</span>` : ""}${s.availability ? `<br/><b style="font-size:12px">${esc(s.availability)}</b>` : ""}<br/><a href="${dir}" target="_blank" rel="noopener noreferrer" style="font-size:13px;font-weight:700;text-decoration:underline">Directions →</a>`,
          );
          new mapboxgl.Marker({ element: el }).setLngLat([s.lng, s.lat]).setPopup(popup).addTo(map);
        }
        if (stations.length > 1) {
          const b = new mapboxgl.LngLatBounds();
          stations.forEach((s) => b.extend([s.lng, s.lat]));
          map.fitBounds(b, { padding: 80, maxZoom: 12, duration: 0 });
        } else if (stations.length === 1) map.jumpTo({ center: [stations[0].lng, stations[0].lat], zoom: 12 });
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    if (!io) start(); // no IntersectionObserver — initialize immediately
    return () => { cancelled = true; io?.disconnect(); clearTimeout(loadTimeout); map?.remove(); mapRef.current = null; };
  }, [stations, interactive]);

  useEffect(() => {
    if (focus && mapRef.current) mapRef.current.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? 10, essential: true });
  }, [focus]);

  if (!TOKEN || status === "error") {
    return (
      <div className={`relative flex items-center justify-center overflow-hidden bg-forest ${className}`} role="status">
        <div className="bg-grid absolute inset-0 opacity-70" aria-hidden />
        <div className="relative max-w-sm p-6 text-center text-white">
          <p className="eyebrow justify-center text-lime">Station locations</p>
          <p className="mt-3 text-sm text-white/70">{stations.length ? "The station map is temporarily unavailable. You can still view verified locations on our locations page." : "Locations are coming soon. Verified stations will appear here as they open."}</p>
          {stations.length > 0 && <a href="/locations" className="mt-4 inline-block text-sm font-bold text-lime underline">View verified locations</a>}
        </div>
      </div>
    );
  }
  return (
    <div className={`relative overflow-hidden bg-forest ${className}`}>
      <div ref={box} className="absolute inset-0" />
      {status === "loading" && (
        <div className="absolute inset-0 grid place-items-center bg-forest text-white" role="status">
          <p className="text-sm">Loading station map…</p>
        </div>
      )}
      {status === "ready" && stations.length === 0 && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 md:left-6 md:right-auto md:max-w-sm">
          <div className="glass rounded-lg p-4 text-white">
            <p className="eyebrow text-lime">Serving Minnesota</p>
            <p className="mt-1 text-sm text-white/80">Pins appear the moment a station goes live. We never place a pin on a location that isn't real.</p>
          </div>
        </div>
      )}
    </div>
  );
}
