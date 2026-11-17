import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { missingPublishFields, VENUE_ADMIN_SELECT } from "@/lib/venues";
import { venueWriteSchema } from "../route";

const uuid = z.string().uuid();
// PATCH accepts any subset of the create schema — same field rules.
const patchSchema = venueWriteSchema.partial().strict();

const KIOSK_TELEMETRY_SELECT =
  "id,station_id,state,installed_at,last_seen_at,slot_count,test_mode,kiosk_slots(state,power_bank_id)";

/**
 * GET /api/system/venues/[id] — venue detail + assigned kiosk telemetry.
 * Serials/heartbeats come from the bound system_devices rows
 * (device_uid ↔ kiosks.station_id is the canonical binding).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Invalid venue id" }, { status: 400 });

  const [{ data: venue, error }, { data: devices }] = await Promise.all([
    g.db.from("venues").select(VENUE_ADMIN_SELECT).eq("id", id).maybeSingle(),
    g.db.from("system_devices")
      .select("id,device_uid,serial_number,model,firmware_version,status,last_heartbeat_at,slot_count,venue_id")
      .eq("venue_id", id).limit(50),
  ]);
  if (error) return NextResponse.json({ error: "Could not load venue." }, { status: 500 });
  if (!venue) return NextResponse.json({ error: "Venue not found" }, { status: 404 });

  const { data: kioskRows } = await g.db.from("kiosks")
    .select(KIOSK_TELEMETRY_SELECT).eq("venue_id", id).limit(50);
  type SlotRow = { state: string; power_bank_id: string | null };
  type KioskRow = {
    id: string; station_id: string; state: string; installed_at: string | null;
    last_seen_at: string | null; slot_count: number; test_mode: boolean;
    kiosk_slots: SlotRow[] | null;
  };
  const deviceByUid = new Map(((devices ?? []) as { device_uid: string | null }[])
    .filter((d): d is { device_uid: string } & typeof d => typeof d.device_uid === "string")
    .map((d) => [d.device_uid, d]));

  const kiosks = ((kioskRows ?? []) as unknown as KioskRow[]).map((k) => {
    const slots = k.kiosk_slots ?? [];
    const dev = deviceByUid.get(k.station_id) ?? null;
    return {
      id: k.id,
      station_id: k.station_id,
      state: k.state,
      installed_at: k.installed_at,
      last_seen_at: k.last_seen_at,
      slot_count: k.slot_count,
      ready_banks: slots.filter((s) => s.state === "ready" && s.power_bank_id != null).length,
      test_mode: k.test_mode === true,
      serial_number: (dev as { serial_number?: string | null } | null)?.serial_number ?? null,
      device_status: (dev as { status?: string | null } | null)?.status ?? null,
      last_heartbeat_at: (dev as { last_heartbeat_at?: string | null } | null)?.last_heartbeat_at ?? null,
      system_device_id: (dev as { id?: string } | null)?.id ?? null,
    };
  });

  return NextResponse.json({ venue, kiosks });
}

/** PATCH /api/system/venues/[id] — update venue fields and/or publish state. Audited. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Invalid venue id" }, { status: 400 });

  const body = await readJson(req);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Invalid venue update", issues: parsed.success ? ["empty"] : parsed.error.issues.slice(0, 8) }, { status: 400 });
  }
  const d = parsed.data;

  // Publishing requires a complete public listing — checked against the
  // merged row, not just the patch, so existing values count.
  if (d.published === true) {
    const { data: existing, error: loadErr } = await g.db.from("venues")
      .select("name,street,city,state,lat,lng").eq("id", id).maybeSingle();
    if (loadErr) return NextResponse.json({ error: "Could not load venue." }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Venue not found" }, { status: 404 });
    const merged = { ...(existing as Record<string, unknown>), ...d };
    const missing = missingPublishFields(merged);
    if (missing.length) {
      return NextResponse.json({ error: `Cannot publish — missing: ${missing.join(", ")}`, missing }, { status: 400 });
    }
  }

  const update: Record<string, unknown> = {};
  for (const key of Object.keys(d) as (keyof typeof d)[]) {
    const v = d[key];
    if (v === undefined) continue;
    update[key] = key === "state" && typeof v === "string" ? v.toUpperCase()
      : key === "contact_email" && v === "" ? null
      : v;
  }

  const { data, error } = await g.db.from("venues").update(update).eq("id", id).select("id,name,published").maybeSingle();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "This Mapbox place is already saved as a venue." }, { status: 409 });
    return NextResponse.json({ error: "Could not update venue." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Venue not found" }, { status: 404 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: d.published === undefined ? "venue.updated" : d.published ? "venue.published" : "venue.unpublished",
    resource: `venue:${id}`,
    detail: { fields: Object.keys(update), name: data.name, published: data.published },
  });
  return NextResponse.json({ venue: data });
}
