"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Map as MapboxMap, Marker } from "mapbox-gl";

export type VenueItem = {
  id: string;
  name: string;
  venue_type: string;
  street: string;
  city: string;
  state: string;
  zip: string | null;
  hours: string | null;
  lat: number | null;
  lng: number | null;
  published: boolean;
  active: boolean;
  organization_id: string | null;
  equipment_category: string | null;
  mapbox_id: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  cover_image_url: string | null;
  timezone: string | null;
  accessibility: string | null;
  internal_notes: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  kiosk_count: number;
  device_count: number;
};

export type OrgItem = { id: string; name: string };

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

const VENUE_TYPES = [
  "bar", "restaurant", "cafe", "nightclub", "brewery",
  "shopping_mall", "retail", "convenience_store", "gas_station",
  "hotel", "gym", "entertainment", "event_venue", "campus", "transport", "other",
];
const TYPE_LABEL = (t: string) => t.replace(/_/g, " ");

const inputCls = "h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-lime/50 focus:outline-none";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

const EMPTY = {
  name: "", venue_type: "bar", street: "", city: "", state: "MN", zip: "",
  hours: "", lat: "", lng: "", organization_id: "", equipment_category: "",
  mapbox_id: "", phone: "", website: "", description: "", cover_image_url: "",
  timezone: "America/Chicago", accessibility: "", internal_notes: "",
  contact_name: "", contact_email: "", contact_phone: "", active: true,
};

type FormState = typeof EMPTY;

/* ── Mapbox autocomplete ─────────────────────────────────────────────── */

type Suggestion = { mapbox_id: string; name: string; place_formatted: string | null; address: string | null };

function VenueSearch({ onPick, onUnavailable }: {
  onPick: (v: Record<string, string | number | null>) => void;
  onUnavailable: (msg: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Suggestion[]>([]);
  const session = useRef<string>(crypto.randomUUID());
  const abort = useRef<AbortController | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { abort.current?.abort(); if (debounce.current) clearTimeout(debounce.current); }, []);

  const search = useCallback((value: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    if (value.trim().length < 3) { setResults([]); setOpen(false); return; }
    debounce.current = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(`/api/system/mapbox/suggest?q=${encodeURIComponent(value)}&session=${session.current}`, { signal: ctrl.signal });
        if (res.status === 503) { onUnavailable("Mapbox isn't configured — enter the venue manually below."); setOpen(false); return; }
        if (!res.ok) { setResults([]); setOpen(false); return; }
        const j = await res.json();
        setResults(j.suggestions ?? []);
        setOpen(true);
      } catch { /* aborted or offline — keep typing */ }
      finally { setLoading(false); }
    }, 300);
  }, [onUnavailable]);

  const pick = async (s: Suggestion) => {
    setOpen(false);
    setQ(`${s.name}${s.place_formatted ? ` — ${s.place_formatted}` : ""}`);
    setLoading(true);
    try {
      const res = await fetch(`/api/system/mapbox/retrieve?id=${encodeURIComponent(s.mapbox_id)}&session=${session.current}`);
      if (!res.ok) { onUnavailable("Couldn't load that place's details — fill in the fields manually."); return; }
      const j = await res.json();
      onPick(j.venue as Record<string, string | number | null>);
    } finally { setLoading(false); }
  };

  return (
    <div className="relative">
      <label className={labelCls}>Find the venue on Mapbox</label>
      <input
        className={inputCls}
        value={q}
        onChange={(e) => { setQ(e.target.value); search(e.target.value); }}
        onFocus={() => results.length && setOpen(true)}
        placeholder={"e.g. \"McCoy's Pub Elk River\""}
        autoComplete="off"
      />
      {loading && <p className="mt-1 text-[11px] text-slate-500">Searching Mapbox…</p>}
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-white/10 bg-[#11122B] shadow-2xl" role="listbox">
          {results.map((s) => (
            <li key={s.mapbox_id}>
              <button type="button" onClick={() => pick(s)} role="option" aria-selected={false}
                className="block w-full px-3 py-2.5 text-left hover:bg-white/10">
                <span className="block truncate text-sm font-semibold text-slate-100">{s.name}</span>
                <span className="block truncate text-xs text-slate-400">{s.place_formatted ?? s.address ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && results.length === 0 && (
        <p className="mt-1 text-[11px] text-slate-500">No Mapbox matches — fill the form manually.</p>
      )}
      <p className="mt-1 text-[10px] text-slate-600">Suggestions powered by Mapbox — verify every field before saving.</p>
    </div>
  );
}

/* ── Map preview ─────────────────────────────────────────────────────── */

function MapPreview({ lat, lng }: { lat: number | null; lng: number | null }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapboxMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !box.current || map.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const mapboxgl = (await import("mapbox-gl")).default;
        await import("mapbox-gl/dist/mapbox-gl.css");
        if (cancelled || !box.current) return;
        mapboxgl.accessToken = MAPBOX_TOKEN;
        map.current = new mapboxgl.Map({
          container: box.current, style: "mapbox://styles/mapbox/dark-v11",
          center: [-94.3, 46.3], zoom: 5, interactive: true, attributionControl: false,
        });
        map.current.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; map.current?.remove(); map.current = null; marker.current = null; };
  }, []);

  useEffect(() => {
    void (async () => {
      if (!map.current || lat == null || lng == null) return;
      const mapboxgl = (await import("mapbox-gl")).default;
      marker.current?.remove();
      marker.current = new mapboxgl.Marker({ color: "#D9FF73" }).setLngLat([lng, lat]).addTo(map.current!);
      map.current!.flyTo({ center: [lng, lat], zoom: Math.max(map.current!.getZoom(), 13), essential: true });
    })();
  }, [lat, lng]);

  if (!MAPBOX_TOKEN || failed) {
    return (
      <div className="grid h-full min-h-48 place-items-center rounded-xl border border-white/10 bg-black/20 p-4 text-center text-xs text-slate-500">
        Map preview unavailable{!MAPBOX_TOKEN ? " — NEXT_PUBLIC_MAPBOX_TOKEN isn't set" : ""}.
        {lat != null && lng != null && <span className="mt-1 block font-mono">{lat.toFixed(5)}, {lng.toFixed(5)}</span>}
      </div>
    );
  }
  return <div ref={box} className="h-full min-h-48 overflow-hidden rounded-xl border border-white/10" />;
}

/* ── Venue form ──────────────────────────────────────────────────────── */

type Dup = { id: string; name: string; city: string; state: string; why: string };

function VenueForm({ initial, organizations, excludeId, onSubmit, onCancel }: {
  initial: FormState;
  organizations: OrgItem[];
  excludeId?: string;
  onSubmit: (f: FormState, publish: boolean) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const [busy, setBusy] = useState<"draft" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dups, setDups] = useState<Dup[]>([]);
  const dupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const on = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    set(k, (e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value) as never);

  const latNum = f.lat.trim() === "" ? null : Number(f.lat);
  const lngNum = f.lng.trim() === "" ? null : Number(f.lng);

  // Debounced soft duplicate check — warns but never blocks (the unique
  // mapbox_id index is the hard stop).
  useEffect(() => {
    if (dupTimer.current) clearTimeout(dupTimer.current);
    if (!f.name.trim()) { setDups([]); return; }
    dupTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/system/venues/duplicates", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: f.name, city: f.city || null, state: f.state || null,
            lat: latNum, lng: lngNum, mapbox_id: f.mapbox_id || null, exclude_id: excludeId ?? null,
          }),
        });
        if (res.ok) setDups((await res.json()).duplicates ?? []);
      } catch { /* dup check is advisory — never block the form */ }
    }, 500);
    return () => { if (dupTimer.current) clearTimeout(dupTimer.current); };
  }, [f.name, f.city, f.state, f.mapbox_id, latNum, lngNum, excludeId]);

  const fillFromMapbox = (v: Record<string, string | number | null>) => {
    setF((p) => ({
      ...p,
      name: (v.name as string) || p.name,
      venue_type: (v.venue_type as string) || p.venue_type,
      street: (v.street as string) || p.street,
      city: (v.city as string) || p.city,
      state: (v.state as string) || p.state,
      zip: (v.zip as string) || p.zip,
      lat: v.lat != null ? String(v.lat) : p.lat,
      lng: v.lng != null ? String(v.lng) : p.lng,
      mapbox_id: (v.mapbox_id as string) || p.mapbox_id,
      phone: (v.phone as string) || p.phone,
      website: (v.website as string) || p.website,
      hours: (v.hours as string) || p.hours,
      accessibility: (v.accessibility as string) || p.accessibility,
      cover_image_url: (v.cover_image_url as string) || p.cover_image_url,
    }));
    setNotice("Details filled from Mapbox — verify before saving. Hours and owner aren't always provided.");
  };

  const publishable = Boolean(f.name.trim() && f.street.trim() && f.city.trim() && f.state.trim().length === 2 && latNum != null && lngNum != null);

  const submit = async (publish: boolean) => {
    setBusy(publish ? "publish" : "draft");
    setError(null);
    const err = await onSubmit(f, publish);
    setBusy(null);
    if (err) setError(err);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <VenueSearch onPick={fillFromMapbox} onUnavailable={setNotice} />
        {notice && <p className="rounded-lg border border-lime/25 bg-lime/10 px-3 py-2 text-xs text-lime">{notice}</p>}
        {dups.length > 0 && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            <p className="font-bold">Possible duplicate{dups.length > 1 ? "s" : ""} — check before saving:</p>
            {dups.map((d) => <p key={d.id} className="mt-0.5">• {d.name} ({d.city}, {d.state}) — matched by {d.why}</p>)}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className={labelCls}>Name *</label><input className={inputCls} value={f.name} onChange={on("name")} required maxLength={160} /></div>
          <div><label className={labelCls}>Type *</label>
            <select className={inputCls} value={f.venue_type} onChange={on("venue_type")}>
              {VENUE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL(t)}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>Owner organization</label>
            <select className={inputCls} value={f.organization_id} onChange={on("organization_id")}>
              <option value="">— none —</option>
              {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>Equipment category</label><input className={inputCls} value={f.equipment_category} onChange={on("equipment_category")} maxLength={60} placeholder="charging, vending…" /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Street *</label><input className={inputCls} value={f.street} onChange={on("street")} required maxLength={200} /></div>
          <div><label className={labelCls}>City *</label><input className={inputCls} value={f.city} onChange={on("city")} required maxLength={80} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>State *</label><input className={inputCls} value={f.state} onChange={on("state")} required maxLength={2} placeholder="MN" /></div>
            <div><label className={labelCls}>ZIP</label><input className={inputCls} value={f.zip} onChange={on("zip")} maxLength={10} /></div>
          </div>
          <div><label className={labelCls}>Latitude</label><input className={inputCls} value={f.lat} onChange={on("lat")} inputMode="decimal" /></div>
          <div><label className={labelCls}>Longitude</label><input className={inputCls} value={f.lng} onChange={on("lng")} inputMode="decimal" /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Hours</label><input className={inputCls} value={f.hours} onChange={on("hours")} maxLength={400} placeholder="Mon–Fri 7am–6pm · Sat 8am–8pm" /></div>
          <div><label className={labelCls}>Timezone</label><input className={inputCls} value={f.timezone} onChange={on("timezone")} maxLength={60} placeholder="America/Chicago" /></div>
          <div><label className={labelCls}>Phone</label><input className={inputCls} value={f.phone} onChange={on("phone")} maxLength={40} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Website</label><input className={inputCls} value={f.website} onChange={on("website")} maxLength={300} placeholder="https://…" /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Description</label><textarea className={`${inputCls} h-20 py-2`} value={f.description} onChange={on("description")} maxLength={2000} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Logo / cover image URL</label><input className={inputCls} value={f.cover_image_url} onChange={on("cover_image_url")} maxLength={300} placeholder="https://…" /></div>
          <div className="sm:col-span-2"><label className={labelCls}>Accessibility info</label><input className={inputCls} value={f.accessibility} onChange={on("accessibility")} maxLength={400} placeholder="Wheelchair accessible entrance…" /></div>
        </div>

        <details className="rounded-lg border border-white/10 bg-black/10 p-3">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-slate-500">Internal only — never shown publicly</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Contact name</label><input className={inputCls} value={f.contact_name} onChange={on("contact_name")} maxLength={120} /></div>
            <div><label className={labelCls}>Contact phone</label><input className={inputCls} value={f.contact_phone} onChange={on("contact_phone")} maxLength={40} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Contact email</label><input className={inputCls} type="email" value={f.contact_email} onChange={on("contact_email")} maxLength={160} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Internal notes</label><textarea className={`${inputCls} h-16 py-2`} value={f.internal_notes} onChange={on("internal_notes")} maxLength={2000} /></div>
          </div>
        </details>

        <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <input type="checkbox" checked={f.active} onChange={on("active")} className="size-4 accent-[#d9ff73]" />
          Operationally active (inactive venues never appear publicly)
        </label>

        {error && <p className="text-xs text-red-300">{error}</p>}
        {!publishable && <p className="text-[11px] text-slate-500">Publish needs: name, street, city, state, and coordinates.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy !== null} onClick={() => submit(false)}
            className="rounded-lg border border-white/15 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-white/5 disabled:opacity-50">
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" disabled={busy !== null || !publishable} onClick={() => submit(true)}
            title={publishable ? "Save and publish publicly" : "Complete the required fields first"}
            className="rounded-lg bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-40">
            {busy === "publish" ? "Publishing…" : "Publish"}
          </button>
          {onCancel && <button type="button" onClick={onCancel} className="rounded-lg border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5">Cancel</button>}
        </div>
      </div>
      <MapPreview lat={latNum} lng={lngNum} />
    </div>
  );
}

/* ── Kiosk telemetry panel ───────────────────────────────────────────── */

type KioskInfo = {
  id: string; station_id: string; state: string; installed_at: string | null;
  last_seen_at: string | null; slot_count: number; ready_banks: number;
  test_mode: boolean; serial_number: string | null; device_status: string | null;
  last_heartbeat_at: string | null; system_device_id: string | null;
};
type DeviceOption = { id: string; device_uid: string | null; serial_number: string | null; venue_id: string | null };

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

function KioskPanel({ venueId }: { venueId: string }) {
  const [kiosks, setKiosks] = useState<KioskInfo[] | null>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/system/venues/${venueId}`);
    if (!res.ok) { setError("Couldn't load kiosks."); return; }
    const j = await res.json();
    setKiosks(j.kiosks ?? []);
  }, [venueId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/system/devices");
      if (res.ok) setDevices(((await res.json()).devices ?? []) as DeviceOption[]);
    })();
  }, []);

  const assign = async (deviceId: string) => {
    setBusy(true); setError(null);
    const res = await fetch("/api/system/kiosks/onboarding", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign_venue", device_id: deviceId, venue_id: venueId }),
    });
    setBusy(false);
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "Assignment failed."); return; }
    void load();
  };

  if (error) return <p className="mt-2 text-xs text-red-300">{error}</p>;
  if (!kiosks) return <p className="mt-2 text-xs text-slate-500">Loading kiosks…</p>;

  const unassigned = devices.filter((d) => d.venue_id !== venueId);

  return (
    <div className="mt-3 space-y-2">
      {kiosks.length === 0 && <p className="text-xs text-slate-500">No kiosks assigned to this venue.</p>}
      {kiosks.map((k) => (
        <div key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
          <span className="font-mono font-bold text-slate-100">{k.station_id}</span>
          {k.test_mode && <span className="rounded-full bg-purple-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-purple-300 ring-1 ring-purple-400/30">TEST MODE</span>}
          <span className={`font-semibold ${k.state === "online" ? "text-lime" : "text-slate-400"}`}>{k.state}</span>
          <span className="text-slate-500">serial {k.serial_number ?? "—"}</span>
          <span className="text-slate-500">heartbeat {ago(k.last_heartbeat_at ?? k.last_seen_at)}</span>
          <span className="text-slate-300">{k.ready_banks}/{k.slot_count} banks ready</span>
          {k.device_status && <span className="text-slate-500">device: {k.device_status}</span>}
        </div>
      ))}
      {unassigned.length > 0 && (
        <div className="flex items-center gap-2">
          <select id={`assign-${venueId}`} className={`${inputCls} h-8 max-w-72 text-xs`} disabled={busy}>
            {unassigned.map((d) => (
              <option key={d.id} value={d.id}>
                {d.device_uid ?? "—"} {d.serial_number ? `(${d.serial_number})` : ""} {d.venue_id ? "· reassign" : "· unassigned"}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy}
            onClick={() => { const sel = document.getElementById(`assign-${venueId}`) as HTMLSelectElement; if (sel?.value) void assign(sel.value); }}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-white/5 disabled:opacity-50">
            {busy ? "Assigning…" : "Assign kiosk"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Manager ─────────────────────────────────────────────────────────── */

function toPayload(f: FormState, publish: boolean) {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const str = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    name: f.name.trim(), venue_type: f.venue_type, street: f.street.trim(),
    city: f.city.trim(), state: f.state.trim().toUpperCase(),
    zip: str(f.zip), hours: str(f.hours), lat: num(f.lat), lng: num(f.lng),
    organization_id: str(f.organization_id), equipment_category: str(f.equipment_category),
    published: publish,
    mapbox_id: str(f.mapbox_id), phone: str(f.phone), website: str(f.website),
    description: str(f.description), cover_image_url: str(f.cover_image_url),
    timezone: str(f.timezone), accessibility: str(f.accessibility),
    internal_notes: str(f.internal_notes), contact_name: str(f.contact_name),
    contact_email: str(f.contact_email), contact_phone: str(f.contact_phone),
    active: f.active,
  };
}

const toForm = (v: VenueItem): FormState => ({
  name: v.name, venue_type: VENUE_TYPES.includes(v.venue_type) ? v.venue_type : "other",
  street: v.street, city: v.city, state: v.state, zip: v.zip ?? "",
  hours: v.hours ?? "", lat: v.lat?.toString() ?? "", lng: v.lng?.toString() ?? "",
  organization_id: v.organization_id ?? "", equipment_category: v.equipment_category ?? "",
  mapbox_id: v.mapbox_id ?? "", phone: v.phone ?? "", website: v.website ?? "",
  description: v.description ?? "", cover_image_url: v.cover_image_url ?? "",
  timezone: v.timezone ?? "America/Chicago", accessibility: v.accessibility ?? "",
  internal_notes: v.internal_notes ?? "", contact_name: v.contact_name ?? "",
  contact_email: v.contact_email ?? "", contact_phone: v.contact_phone ?? "", active: v.active !== false,
});

export function VenuesManager({ venues, organizations, canManage }: { venues: VenueItem[]; organizations: OrgItem[]; canManage: boolean }) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const published = venues.filter((v) => v.published).length;
  const withKiosks = venues.filter((v) => v.kiosk_count > 0).length;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? venues.filter((v) => `${v.name} ${v.city} ${v.state} ${v.venue_type}`.toLowerCase().includes(q))
    : venues;

  const create = async (f: FormState, publish: boolean) => {
    const res = await fetch("/api/system/venues", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toPayload(f, publish)),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); return j?.error ?? "Could not create venue."; }
    setShowCreate(false); router.refresh(); return null;
  };

  const saveEdit = (id: string) => async (f: FormState, publish: boolean) => {
    const res = await fetch(`/api/system/venues/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...toPayload(f, publish), published: publish || undefined }),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); return j?.error ?? "Could not update venue."; }
    setEditing(null); router.refresh(); return null;
  };

  const togglePublish = async (v: VenueItem) => {
    setBusyId(v.id); setError(null);
    const res = await fetch(`/api/system/venues/${v.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ published: !v.published }),
    });
    setBusyId(null);
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "Could not update venue."); return; }
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([["Total venues", venues.length], ["Published", published], ["With kiosks", withKiosks], ["Unpublished", venues.length - published]] as const).map(([l, n]) => (
          <div key={l} className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
            <p className="font-mono text-xl font-bold text-slate-100">{n}</p>
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">{l}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">Venue registry</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">{filtered.length} of {venues.length} venue(s)</p>
          </div>
          <div className="flex items-center gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search venues…"
              className="w-48 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/50 focus:outline-none" />
            {canManage && (
              <button type="button" onClick={() => setShowCreate((s) => !s)}
                className="rounded-lg bg-lime px-3 py-1.5 text-xs font-bold text-ink hover:bg-[#e6ffa8]">
                {showCreate ? "Close" : "+ Add venue"}
              </button>
            )}
          </div>
        </div>

        {error && <p className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        {showCreate && canManage && (
          <div className="mt-4 rounded-xl border border-lime/20 bg-black/20 p-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-lime">New venue — search Mapbox or enter manually</h3>
            <VenueForm initial={EMPTY} organizations={organizations} onSubmit={create} onCancel={() => setShowCreate(false)} />
          </div>
        )}

        {filtered.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-black/20 px-4 py-6 text-center text-sm text-slate-400">
            {venues.length === 0 ? "No venues yet — add your first location above." : "No venues match that search."}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {filtered.map((v) => {
              const isEditing = editing === v.id;
              const isExpanded = expanded === v.id;
              return (
                <li key={v.id} className="py-3">
                  {isEditing ? (
                    <VenueForm initial={toForm(v)} organizations={organizations} excludeId={v.id} onSubmit={saveEdit(v.id)} onCancel={() => setEditing(null)} />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-100">{v.name}</p>
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${v.published ? "bg-lime/15 text-lime ring-lime/30" : "bg-slate-400/10 text-slate-400 ring-slate-400/25"}`}>
                            {v.published ? "published" : "unpublished"}
                          </span>
                          {v.active === false && <span className="rounded-full bg-red-400/15 px-2 py-0.5 font-mono text-[10px] font-bold text-red-300 ring-1 ring-red-400/30">inactive</span>}
                          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-white/10">{TYPE_LABEL(v.venue_type)}</span>
                          {v.mapbox_id && <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 font-mono text-[10px] text-cyan-300 ring-1 ring-cyan-400/20" title={v.mapbox_id}>mapbox</span>}
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">{v.street}, {v.city}, {v.state}{v.zip ? ` ${v.zip}` : ""}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                          {v.kiosk_count} kiosk(s) · {v.device_count} device(s)
                          {v.hours ? ` · ${v.hours}` : ""}
                          {v.lat != null && v.lng != null ? ` · ${Number(v.lat).toFixed(4)}, ${Number(v.lng).toFixed(4)}` : " · no coordinates"}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button type="button" onClick={() => setExpanded(isExpanded ? null : v.id)}
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5">
                          {isExpanded ? "Hide kiosks" : "Kiosks"}
                        </button>
                        {canManage && (
                          <>
                            <button type="button" onClick={() => setEditing(v.id)}
                              className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5">Edit</button>
                            <button type="button" disabled={busyId === v.id} onClick={() => togglePublish(v)}
                              className={`rounded-lg px-3 py-1.5 text-[11px] font-bold disabled:opacity-50 ${v.published ? "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15" : "bg-lime text-ink hover:bg-[#e6ffa8]"}`}>
                              {v.published ? "Unpublish" : "Publish"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {isExpanded && !isEditing && <KioskPanel venueId={v.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
