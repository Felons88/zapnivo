import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { systemAudit } from "@/lib/system/audit";
import { missingPublishFields, VENUE_ADMIN_SELECT } from "@/lib/venues";
import { VENUE_TYPES } from "@/lib/mapbox";

const uuid = z.string().uuid();
const venueType = z.string().trim().min(1).max(60).refine(
  (t) => (VENUE_TYPES as readonly string[]).includes(t) || /^[a-z][a-z0-9_ -]{0,58}$/i.test(t),
  { message: "unknown venue type" },
);
const optUrl = z.string().trim().max(300).nullish().refine(
  (u) => !u || /^https?:\/\//i.test(u), { message: "must be an http(s) URL" },
);

export const venueWriteSchema = z.object({
  name: z.string().trim().min(1).max(160),
  venue_type: venueType,
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().length(2),
  zip: z.string().trim().max(10).nullish(),
  hours: z.string().trim().max(400).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  organization_id: uuid.nullish(),
  equipment_category: z.string().trim().max(60).nullish(),
  published: z.boolean().optional(),
  // Enrichment (migration 0080)
  mapbox_id: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  website: optUrl,
  description: z.string().trim().max(2000).nullish(),
  cover_image_url: optUrl,
  timezone: z.string().trim().max(60).nullish(),
  accessibility: z.string().trim().max(400).nullish(),
  internal_notes: z.string().trim().max(2000).nullish(),
  contact_name: z.string().trim().max(120).nullish(),
  contact_email: z.string().trim().email().max(160).nullish().or(z.literal("")),
  contact_phone: z.string().trim().max(40).nullish(),
  active: z.boolean().optional(),
});

export type VenueRow = {
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
  created_at: string;
};

/** GET /api/system/venues — list venues with bound kiosk/device counts. */
export async function GET() {
  const g = await systemApiGuard("system.kiosks.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { data, error } = await g.db.from("venues")
    .select(VENUE_ADMIN_SELECT)
    .order("name").limit(500);
  if (error) return NextResponse.json({ error: "Could not load venues." }, { status: 500 });

  const venues = (data ?? []) as VenueRow[];
  const ids = venues.map((v) => v.id);
  const [kiosks, devices] = ids.length ? await Promise.all([
    g.db.from("kiosks").select("venue_id").in("venue_id", ids),
    g.db.from("system_devices").select("venue_id").in("venue_id", ids),
  ]) : [{ data: [] }, { data: [] }];
  const kioskCount = new Map<string, number>();
  for (const k of (kiosks.data ?? []) as { venue_id: string | null }[]) {
    if (k.venue_id) kioskCount.set(k.venue_id, (kioskCount.get(k.venue_id) ?? 0) + 1);
  }
  const deviceCount = new Map<string, number>();
  for (const d of (devices.data ?? []) as { venue_id: string | null }[]) {
    if (d.venue_id) deviceCount.set(d.venue_id, (deviceCount.get(d.venue_id) ?? 0) + 1);
  }
  return NextResponse.json({
    venues: venues.map((v) => ({ ...v, kiosk_count: kioskCount.get(v.id) ?? 0, device_count: deviceCount.get(v.id) ?? 0 })),
  });
}

/** POST /api/system/venues — create a venue (unpublished unless explicitly published). Audited. */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = venueWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid venue", issues: parsed.error.issues.slice(0, 8) }, { status: 400 });
  }
  const d = parsed.data;

  if (d.published === true) {
    const missing = missingPublishFields(d);
    if (missing.length) {
      return NextResponse.json({ error: `Cannot publish — missing: ${missing.join(", ")}`, missing }, { status: 400 });
    }
  }

  const { data, error } = await g.db.from("venues").insert({
    name: d.name, venue_type: d.venue_type, street: d.street, city: d.city,
    state: d.state.toUpperCase(), zip: d.zip ?? null, hours: d.hours ?? null,
    lat: d.lat ?? null, lng: d.lng ?? null, organization_id: d.organization_id ?? null,
    equipment_category: d.equipment_category ?? null, published: d.published === true,
    mapbox_id: d.mapbox_id ?? null,
    phone: d.phone ?? null, website: d.website ?? null, description: d.description ?? null,
    cover_image_url: d.cover_image_url ?? null, timezone: d.timezone ?? null,
    accessibility: d.accessibility ?? null, internal_notes: d.internal_notes ?? null,
    contact_name: d.contact_name ?? null, contact_email: d.contact_email || null,
    contact_phone: d.contact_phone ?? null, active: d.active !== false,
  }).select("id").single();
  if (error || !data) {
    if (error?.code === "23505") return NextResponse.json({ error: "This Mapbox place is already saved as a venue." }, { status: 409 });
    return NextResponse.json({ error: "Could not create venue." }, { status: 500 });
  }
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "venue.created",
    resource: `venue:${data.id}`,
    detail: { name: d.name, city: d.city, state: d.state.toUpperCase(), published: d.published === true, mapbox_id: d.mapbox_id ?? null },
  });
  return NextResponse.json({ venue: { id: data.id } }, { status: 201 });
}
