import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { queueCommand } from "@/lib/kiosk/commands";
import { serviceClient } from "@/lib/supabase";

const uuid = z.string().uuid();
const venueSchema = z.object({
  name: z.string().trim().min(1).max(160), venue_type: z.string().trim().min(1).max(60),
  street: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(80),
  state: z.string().trim().length(2), zip: z.string().trim().max(10).optional(),
  organization_id: uuid.nullable().optional(),
});
const kioskSchema = z.object({ venue_id: uuid.nullable().optional(), model: z.string().trim().max(80).optional(), slot_count: z.coerce.number().int().min(1).max(64).default(8) });
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** Staff fleet operations. Every mutation is audit-logged; feedback is shown via ?result= on the originating page. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const rt = String(form.get("return_to") ?? "");
  const dest = /^\/admin\/[A-Za-z0-9/_-]*$/.test(rt) ? rt : "/admin/fleet";
  const back = (result: string, detail?: string) => {
    const url = new URL(dest, req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail);
    return NextResponse.redirect(url, 303);
  };
  const fail = (detail: string) => back("error", detail);
  const actor = user!.id;
  const profileId = /^[0-9a-f-]{36}$/i.test(actor) ? actor : null;

  if (action === "create_venue") {
    const p = venueSchema.safeParse({
      name: form.get("name"), venue_type: form.get("venue_type"), street: form.get("street"), city: form.get("city"),
      state: form.get("state"), zip: form.get("zip") || undefined, organization_id: form.get("organization_id") || null,
    });
    if (!p.success) return fail("Check the venue fields.");
    const { data, error } = await db.from("venues").insert({
      name: p.data.name, venue_type: p.data.venue_type, street: p.data.street, city: p.data.city,
      state: p.data.state.toUpperCase(), zip: p.data.zip ?? null, organization_id: p.data.organization_id ?? null, published: false,
    }).select("id").single();
    if (error) return fail("The venue could not be created.");
    await auditLog(actor, "create_venue", "venue", data?.id, { name: p.data.name });
    return back("venue");
  }

  if (action === "create_kiosk") {
    const p = kioskSchema.safeParse({ venue_id: form.get("venue_id") || null, model: form.get("model") || undefined, slot_count: form.get("slot_count") || 8 });
    if (!p.success) return fail("Slot count must be between 1 and 64.");
    const station_id = `ZN-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const { data, error } = await db.from("kiosks").insert({ station_id, venue_id: p.data.venue_id ?? null, model: p.data.model ?? null, slot_count: p.data.slot_count, state: "provisioning" }).select("id").single();
    if (error || !data) return fail("The kiosk could not be registered.");
    const slots = Array.from({ length: p.data.slot_count }, (_, i) => ({ kiosk_id: data.id, slot_number: i + 1, state: "empty" as const }));
    const { error: slotError } = await db.from("kiosk_slots").insert(slots);
    if (slotError) {
      await db.from("kiosks").delete().eq("id", data.id); // never leave a kiosk without its slot records
      return fail("The kiosk slots could not be created, so nothing was registered.");
    }
    await auditLog(actor, "create_kiosk", "kiosk", data.id, { station_id, slots: p.data.slot_count });
    return back("created", station_id);
  }

  if (action === "assign_kiosk") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    const venueId = String(form.get("venue_id") ?? "") || null;
    if (!uuid.safeParse(kioskId).success || (venueId && !uuid.safeParse(venueId).success)) return fail("Invalid kiosk or venue.");
    const { data, error } = await db.from("kiosks").update({ venue_id: venueId }).eq("id", kioskId).select("id").maybeSingle();
    if (error || !data) return fail("The kiosk could not be assigned.");
    await auditLog(actor, "assign_kiosk", "kiosk", kioskId, { venue_id: venueId });
    return back("assigned");
  }

  if (action === "record_installation") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    if (!uuid.safeParse(kioskId).success || form.get("confirmed") !== "yes") return fail("Confirm the physical installation first.");
    const { data: k } = await db.from("kiosks").select("id,venue_id,installed_at").eq("id", kioskId).maybeSingle();
    if (!k?.venue_id) return fail("Assign the kiosk to a venue before recording installation.");
    if (k.installed_at) return fail("Installation was already recorded.");
    const { error } = await db.from("kiosks").update({ installed_at: new Date().toISOString() }).eq("id", kioskId);
    if (error) return fail("The installation could not be recorded.");
    await auditLog(actor, "record_installation", "kiosk", kioskId);
    return back("installed");
  }

  if (action === "set_kiosk_state") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    const to = String(form.get("to") ?? "");
    const reason = String(form.get("reason") ?? "").trim().slice(0, 300) || null;
    if (!uuid.safeParse(kioskId).success || !["disable", "enable"].includes(to)) return fail("Invalid request.");
    const next = to === "disable" ? { state: "disabled", disabled_reason: reason } : { state: "online", disabled_reason: null };
    const { error } = await db.from("kiosks").update(next).eq("id", kioskId);
    if (error) return fail("The station state could not be changed.");
    const q = await queueCommand(db, { kioskId, command: to as "disable" | "enable", issuedBy: actor, payload: { reason } });
    await auditLog(actor, `kiosk_${to}`, "kiosk", kioskId, { reason, command: q.duplicate ? "duplicate" : q.status });
    return back("state");
  }

  if (action === "log_maintenance") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    const notes = String(form.get("notes") ?? "").trim().slice(0, 4000);
    if (!uuid.safeParse(kioskId).success || !notes) return fail("Describe what was done.");
    const { data, error } = await db.from("maintenance_visits").insert({ kiosk_id: kioskId, technician: profileId, notes }).select("id").single();
    if (error) return fail("The visit could not be logged.");
    if (form.get("return_online") === "on") await db.from("kiosks").update({ state: "online", disabled_reason: null }).eq("id", kioskId).eq("state", "maintenance");
    await auditLog(actor, "log_maintenance", "maintenance", data.id, { kiosk_id: kioskId });
    return back("maintenance");
  }

  if (action === "add_note") {
    const entity = String(form.get("entity") ?? "");
    const entityId = String(form.get("entity_id") ?? "");
    const body = String(form.get("body") ?? "").trim().slice(0, 4000);
    if (!["rental", "venue", "kiosk", "organization"].includes(entity) || !uuid.safeParse(entityId).success || !body) return fail("Write a note first.");
    const { error } = await db.from("internal_notes").insert({ entity, entity_id: entityId, body, author: profileId });
    if (error) return fail("The note could not be saved.");
    await auditLog(actor, "add_note", entity, entityId);
    return back("note");
  }

  if (action === "upload_file") {
    const kioskId = String(form.get("kiosk_id") ?? "");
    const file = form.get("file");
    if (!uuid.safeParse(kioskId).success || !(file instanceof File) || file.size === 0) return fail("Choose a file.");
    if (!FILE_TYPES.has(file.type)) return fail("Only JPEG, PNG, WebP or PDF files are accepted.");
    if (file.size > 8 * 1024 * 1024) return fail("Files must be 8 MB or smaller.");
    const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
    const path = `${kioskId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const { error: upErr } = await db.storage.from("station-files").upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type });
    if (upErr) return fail("The upload failed.");
    await db.from("installation_files").insert({ kiosk_id: kioskId, kind: file.type === "application/pdf" ? "document" : "photo", storage_path: path, caption: String(form.get("caption") ?? "").trim().slice(0, 200) || null, uploaded_by: profileId });
    await auditLog(actor, "upload_file", "kiosk", kioskId, { type: file.type, bytes: file.size });
    return back("uploaded");
  }

  return fail("Unknown fleet action.");
}
