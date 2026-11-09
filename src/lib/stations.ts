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
