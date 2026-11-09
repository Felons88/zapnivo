import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const back = (req: Request) => NextResponse.redirect(new URL("/admin/fleet", req.url), 303);
const venueSchema = z.object({ name: z.string().trim().min(1).max(160), city: z.string().trim().min(1).max(80), state: z.string().trim().length(2), street: z.string().trim().max(200).optional(), organization_id: z.string().uuid().nullable().optional() });
const kioskSchema = z.object({ venue_id: z.string().uuid().nullable().optional(), model: z.string().trim().max(80).optional(), slot_count: z.coerce.number().int().min(1).max(64).default(8) });

/** Staff fleet operations: create venues, register kiosks, assign kiosks to venues. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "create_venue") {
    const p = venueSchema.safeParse({ name: form.get("name"), city: form.get("city"), state: form.get("state"), street: form.get("street") || undefined, organization_id: form.get("organization_id") || null });
    if (!p.success) return NextResponse.json({ error: "Check the venue fields." }, { status: 422 });
    const { error } = await db.from("venues").insert({ name: p.data.name, city: p.data.city, state: p.data.state.toUpperCase(), street: p.data.street ?? "", venue_type: "venue", organization_id: p.data.organization_id ?? null });
    if (error) return NextResponse.json({ error: "Couldn't create the venue." }, { status: 500 });
    return back(req);
  }

  if (action === "create_kiosk") {
    const p = kioskSchema.safeParse({ venue_id: form.get("venue_id") || null, model: form.get("model") || undefined, slot_count: form.get("slot_count") || 8 });
    if (!p.success) return NextResponse.json({ error: "Check the kiosk fields." }, { status: 422 });
    const station_id = `ZN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const { error } = await db.from("kiosks").insert({ station_id, venue_id: p.data.venue_id ?? null, model: p.data.model ?? null, slot_count: p.data.slot_count, state: "provisioning" });
    if (error) return NextResponse.json({ error: "Couldn't register the kiosk." }, { status: 500 });
    return back(req);
  }

  if (action === "assign_kiosk") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    const venueId = String(form.get("venue_id") ?? "") || null;
    const { error } = await db.from("kiosks").update({ venue_id: venueId }).eq("id", kioskId);
    if (error) return NextResponse.json({ error: "Couldn't assign the kiosk." }, { status: 500 });
    return back(req);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
