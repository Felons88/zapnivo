import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const venueSchema = z.object({
  name: z.string().trim().min(1).max(160),
  venue_type: z.string().trim().min(1).max(60),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().length(2).regex(/^[a-zA-Z]{2}$/),
  zip: z.string().trim().max(10).optional(),
  organization_id: z.string().uuid().nullable(),
});
const kioskSchema = z.object({
  venue_id: z.string().uuid().nullable(),
  model: z.string().trim().max(80).optional(),
  slot_count: z.coerce.number().int().min(1).max(64),
});
const assignSchema = z.object({ kiosk_id: z.string().uuid(), venue_id: z.string().uuid().nullable() });

const back = (req: Request, result: "created" | "venue" | "assigned" | "installed" | "error", detail?: string) => {
  const url = new URL("/admin/fleet", req.url);
  url.searchParams.set("result", result);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url, 303);
};

/** Staff-only fleet registration. New kiosks remain provisioning until a real device integration reports health. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "create_venue") {
    const p = venueSchema.safeParse({
      name: form.get("name"), venue_type: form.get("venue_type"), street: form.get("street"),
      city: form.get("city"), state: form.get("state"), zip: form.get("zip") || undefined,
      organization_id: form.get("organization_id") || null,
    });
    if (!p.success) return back(req, "error", "Check the venue name, type and full address.");
    if (p.data.organization_id) {
      const { data } = await db.from("organizations").select("id").eq("id", p.data.organization_id).maybeSingle();
      if (!data) return back(req, "error", "Select an existing organization.");
    }
    const { error } = await db.from("venues").insert({ ...p.data, state: p.data.state.toUpperCase(), zip: p.data.zip || null, published: false });
    if (error) return back(req, "error", "The venue could not be saved.");
    return back(req, "venue");
  }

  if (action === "create_kiosk") {
    const p = kioskSchema.safeParse({ venue_id: form.get("venue_id") || null, model: form.get("model") || undefined, slot_count: form.get("slot_count") });
    if (!p.success) return back(req, "error", "Check the kiosk model, venue and slot count.");
    if (p.data.venue_id) {
      const { data } = await db.from("venues").select("id").eq("id", p.data.venue_id).maybeSingle();
      if (!data) return back(req, "error", "Select an existing venue.");
    }
    const station_id = `ZN-${randomBytes(6).toString("hex").toUpperCase()}`;
    const { data: kiosk, error } = await db.from("kiosks").insert({
      station_id, venue_id: p.data.venue_id, model: p.data.model || null,
      slot_count: p.data.slot_count, state: "provisioning",
    }).select("id").single();
    if (error || !kiosk) return back(req, "error", "The kiosk could not be registered.");

    const slotRows = Array.from({ length: p.data.slot_count }, (_, index) => ({ kiosk_id: kiosk.id, slot_number: index + 1, state: "empty" }));
    const { error: slotError } = await db.from("kiosk_slots").insert(slotRows);
    if (slotError) {
      const { error: rollbackError } = await db.from("kiosks").delete().eq("id", kiosk.id);
      if (rollbackError) return back(req, "error", `Slot setup failed and ${station_id} needs manual cleanup.`);
      return back(req, "error", "Slot setup failed; the kiosk registration was rolled back.");
    }
    return back(req, "created", station_id);
  }

  if (action === "assign_kiosk") {
    const p = assignSchema.safeParse({ kiosk_id: form.get("kiosk_id"), venue_id: form.get("venue_id") || null });
    if (!p.success) return back(req, "error", "Choose a valid kiosk and venue.");
    if (p.data.venue_id) {
      const { data } = await db.from("venues").select("id").eq("id", p.data.venue_id).maybeSingle();
      if (!data) return back(req, "error", "That venue no longer exists.");
    }
    const { data, error } = await db.from("kiosks").update({ venue_id: p.data.venue_id }).eq("id", p.data.kiosk_id).select("id").maybeSingle();
    if (error || !data) return back(req, "error", "The kiosk assignment could not be saved.");
    return back(req, "assigned");
  }

  if (action === "record_installation") {
    const kioskId = z.string().uuid().safeParse(form.get("kiosk_id"));
    if (!kioskId.success || form.get("confirmed") !== "yes") return back(req, "error", "Confirm the physical installation before recording it.");
    const { data: kiosk } = await db.from("kiosks").select("id,venue_id,installed_at").eq("id", kioskId.data).maybeSingle();
    if (!kiosk?.venue_id) return back(req, "error", "Assign the kiosk to a venue before recording installation.");
    if (kiosk.installed_at) return back(req, "error", "Installation is already recorded.");
    const { error } = await db.from("kiosks").update({ installed_at: new Date().toISOString() }).eq("id", kioskId.data);
    if (error) return back(req, "error", "The installation date could not be saved.");
    return back(req, "installed");
  }

  return back(req, "error", "Unknown fleet action.");
}
