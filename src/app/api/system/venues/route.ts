import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../_shared";
import { systemAudit } from "@/lib/system/audit";

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  venue_type: z.string().trim().min(1).max(60),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(2),
  zip: z.string().trim().max(10).optional().or(z.literal("")),
  hours: z.string().trim().max(200).optional().or(z.literal("")),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  organization_id: z.string().uuid().optional().or(z.literal("")),
});

const patchSchema = z.object({
  id: z.string().uuid(),
  published: z.boolean().optional(),
  hours: z.string().trim().max(200).nullable().optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
}).refine((v) => v.published !== undefined || v.hours !== undefined || v.lat !== undefined || v.lng !== undefined, {
  message: "Nothing to update",
});

/** GET /api/system/venues — venue list for System Control. */
export async function GET() {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { data, error } = await g.db
    .from("venues")
    .select("id,name,venue_type,street,city,state,zip,hours,lat,lng,published,organization_id,equipment_category,created_at,organizations(name),kiosks(id,station_id,state,test_mode)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: "Could not load venues." }, { status: 500 });
  return NextResponse.json({ venues: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/system/venues — create a venue (always unpublished). */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Check the venue fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;
  if ((d.lat === undefined) !== (d.lng === undefined)) {
    return NextResponse.json({ error: "Latitude and longitude must be provided together." }, { status: 422 });
  }
  if (d.organization_id) {
    const { data: org } = await g.db.from("organizations").select("id").eq("id", d.organization_id).maybeSingle();
    if (!org) return NextResponse.json({ error: "Owner organization not found." }, { status: 422 });
  }
  const { data, error } = await g.db.from("venues").insert({
    name: d.name, venue_type: d.venue_type, street: d.street, city: d.city, state: d.state.toUpperCase(),
    zip: d.zip || null, hours: d.hours || null,
    lat: d.lat ?? null, lng: d.lng ?? null,
    organization_id: d.organization_id || null,
    published: false,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: "The venue could not be created." }, { status: 500 });
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "venue.created",
    resource: `venue:${data.id}`,
    detail: { name: d.name, city: d.city, state: d.state.toUpperCase() },
  });
  return NextResponse.json({ id: data.id }, { status: 201 });
}

/** PATCH /api/system/venues — publish/unpublish, hours, coordinates. */
export async function PATCH(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 60 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid update.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const { id, ...fields } = parsed.data;
  const update: Record<string, unknown> = {};
  if (fields.published !== undefined) update.published = fields.published;
  if (fields.hours !== undefined) update.hours = fields.hours;
  if (fields.lat !== undefined || fields.lng !== undefined) {
    if ((fields.lat == null) !== (fields.lng == null)) {
      return NextResponse.json({ error: "Latitude and longitude must be set together." }, { status: 422 });
    }
    update.lat = fields.lat ?? null;
    update.lng = fields.lng ?? null;
  }
  const { data, error } = await g.db.from("venues").update(update).eq("id", id).select("id,published").maybeSingle();
  if (error) return NextResponse.json({ error: "The venue could not be updated." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: fields.published === undefined ? "venue.updated" : fields.published ? "venue.published" : "venue.unpublished",
    resource: `venue:${id}`,
    detail: update,
  });
  return NextResponse.json({ id: data.id, published: data.published });
}
