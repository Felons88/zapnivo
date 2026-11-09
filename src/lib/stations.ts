export type Station = {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  hours: string | null;
  availability: string | null;
};

/**
 * Live stations. Replace with a query on `kiosks` joined to `venues where published = true`
 * once installations exist. Intentionally empty: we never pin locations that aren't real.
 * Each entry added here automatically becomes a pin on every Zapnivo map.
 */
export const STATIONS: Station[] = [];

export const MINNESOTA_CENTER: [number, number] = [-94.3, 46.3];

/**
 * Live stations straight from the database: published venues that have a kiosk.
 * Server-only — call from server components. Returns [] when nothing is
 * installed yet or the backend isn't configured; never fabricates a pin.
 */
export async function getStations(): Promise<Station[]> {
  const { serviceClient } = await import("./supabase");
  const db = serviceClient();
  if (!db) return STATIONS;
  const { data, error } = await db
    .from("venues")
    .select("name,street,city,state,zip,hours,lat,lng,kiosks(station_id,state)")
    .eq("published", true);
  if (error || !data) return STATIONS;
  const out: Station[] = [];
  for (const v of data as { name: string; street: string; city: string; state: string; zip: string | null; hours: string | null; lat: number | null; lng: number | null; kiosks: { station_id: string; state: string }[] }[]) {
    for (const k of v.kiosks ?? []) {
      if (k.state === "disabled" || v.lat == null || v.lng == null) continue;
      out.push({
        id: k.station_id, name: v.name,
        address: `${v.street}, ${v.city}, ${v.state}${v.zip ? ` ${v.zip}` : ""}`,
        city: v.city, state: v.state, zip: v.zip ?? "",
        lat: Number(v.lat), lng: Number(v.lng), hours: v.hours, availability: k.state,
      });
    }
  }
  return out;
}
