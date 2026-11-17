import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";

export const bodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(2).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  mapbox_id: z.string().trim().max(120).nullish(),
  exclude_id: z.string().uuid().nullish(),
});

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/** ~75 m at MN latitudes — close enough that two pins are the same premises. */
const NEAR_DEG = 0.00075;

export type DuplicateMatch = { id: string; name: string; city: string; state: string; why: "mapbox_id" | "location" | "name" };

/**
 * Pure matcher, exported for tests: given candidate fields + existing rows,
 * return rows that look like the same venue. Coordinates win, then mapbox_id,
 * then normalized name inside the same city+state.
 */
export function matchVenueDuplicates(
  candidate: { name: string; city?: string | null; state?: string | null; lat?: number | null; lng?: number | null; mapbox_id?: string | null },
  rows: { id: string; name: string; city: string; state: string; lat: number | null; lng: number | null; mapbox_id: string | null }[],
): DuplicateMatch[] {
  const out = new Map<string, DuplicateMatch>();
  const cName = norm(candidate.name);
  const cCity = candidate.city ? norm(candidate.city) : null;
  const cState = candidate.state?.trim().toUpperCase() ?? null;
  for (const r of rows) {
    if (candidate.mapbox_id && r.mapbox_id === candidate.mapbox_id) {
      out.set(r.id, { id: r.id, name: r.name, city: r.city, state: r.state, why: "mapbox_id" });
      continue;
    }
    if (candidate.lat != null && candidate.lng != null && r.lat != null && r.lng != null &&
        Math.abs(r.lat - candidate.lat) < NEAR_DEG && Math.abs(r.lng - candidate.lng) < NEAR_DEG) {
      out.set(r.id, { id: r.id, name: r.name, city: r.city, state: r.state, why: "location" });
      continue;
    }
    if (cCity && cState && norm(r.name) === cName && norm(r.city) === cCity && r.state.toUpperCase() === cState) {
      out.set(r.id, { id: r.id, name: r.name, city: r.city, state: r.state, why: "name" });
    }
  }
  return [...out.values()];
}

/**
 * POST /api/system/venues/duplicates — soft duplicate check before save.
 * Read-only, guarded by the same view permission as the venue list; the
 * write endpoints still do their own enforcement (mapbox_id is unique).
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 60 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid duplicate check", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const d = parsed.data;

  const { data, error } = await g.db.from("venues")
    .select("id,name,city,state,lat,lng,mapbox_id")
    .limit(2000);
  if (error) return NextResponse.json({ error: "Could not check for duplicates." }, { status: 500 });

  let rows = (data ?? []) as { id: string; name: string; city: string; state: string; lat: number | null; lng: number | null; mapbox_id: string | null }[];
  if (d.exclude_id) rows = rows.filter((r) => r.id !== d.exclude_id);

  return NextResponse.json({ duplicates: matchVenueDuplicates(d, rows) });
}
