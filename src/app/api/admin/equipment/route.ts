import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import {
  createModel, createUnit, transitionUnit, updateModel, updateUnit,
  isEquipmentStatus, type EquipmentStatus, type ModelInput, type UnitInput,
} from "@/lib/vending-equipment";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Dollars form field → integer cents, or undefined when blank/invalid. */
const dollarsToCents = (v: FormDataEntryValue | null): number | null | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

const modelInput = (form: FormData): ModelInput => ({
  category: String(form.get("category") ?? ""),
  manufacturer: String(form.get("manufacturer") ?? "") || null,
  model_name: String(form.get("model_name") ?? ""),
  capacity_description: String(form.get("capacity_description") ?? "") || null,
  dimensions: String(form.get("dimensions") ?? "") || null,
  acquisition_cost_cents: dollarsToCents(form.get("acquisition_cost_dollars")) ?? dollarsToCents(form.get("acquisition_cost_cents")),
  supplier: String(form.get("supplier") ?? "") || null,
  warranty_months: String(form.get("warranty_months") ?? "") || null,
  connectivity: String(form.get("connectivity") ?? "") || null,
  status: String(form.get("status") ?? "") || undefined,
  notes: String(form.get("notes") ?? "") || null,
});

const unitInput = (form: FormData, partial = false): UnitInput => {
  const full: UnitInput = {
    model_id: String(form.get("model_id") ?? "") || null,
    serial_number: String(form.get("serial_number") ?? "") || null,
    category: String(form.get("category") ?? "") || undefined,
    kiosk_id: String(form.get("kiosk_id") ?? "") || null,
    venue_id: String(form.get("venue_id") ?? "") || null,
    ownership: String(form.get("ownership") ?? "") || undefined,
    cost_cents: dollarsToCents(form.get("cost_dollars")) ?? dollarsToCents(form.get("cost_cents")),
    manufacturer: String(form.get("manufacturer") ?? "") || null,
    model_label: String(form.get("model_label") ?? "") || null,
    service_schedule: String(form.get("service_schedule") ?? "") || null,
    notes: String(form.get("notes") ?? "") || null,
  };
  if (!partial) return full;
  // Only keys the form actually sent — absent keys stay undefined so updateUnit
  // doesn't patch them to null.
  const out: UnitInput = {};
  const pick = <K extends keyof UnitInput>(k: K, sent: boolean) => { if (sent) (out as Record<string, unknown>)[k] = full[k]; };
  pick("model_id", form.has("model_id"));
  pick("serial_number", form.has("serial_number"));
  pick("category", form.has("category"));
  pick("kiosk_id", form.has("kiosk_id"));
  pick("venue_id", form.has("venue_id"));
  pick("ownership", form.has("ownership"));
  pick("cost_cents", form.has("cost_dollars") || form.has("cost_cents"));
  pick("manufacturer", form.has("manufacturer"));
  pick("model_label", form.has("model_label"));
  pick("service_schedule", form.has("service_schedule"));
  pick("notes", form.has("notes"));
  return out;
};

/**
 * Equipment catalog + unit fleet admin actions. Lifecycle transitions are staff;
 * catalog/unit record changes (create/update, venue/kiosk links) are admin-only
 * since they alter asset records used for payback and agreement math.
 * Every mutation is audit-logged; feedback returns via ?result= on /admin/equipment.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = (result: string, detail?: string) => {
    const url = new URL("/admin/equipment", req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail.slice(0, 120));
    return NextResponse.redirect(url, 303);
  };
  const fail = (detail: string) => back("error", detail);
  const actor = user!.id;

  /* ── Staff: lifecycle transitions ── */
  if (action === "transition") {
    const unitId = String(form.get("unit_id") ?? "");
    const to = String(form.get("to") ?? "") as EquipmentStatus;
    if (!UUID_RE.test(unitId) || !isEquipmentStatus(to)) return fail("Invalid transition request.");
    const r = await transitionUnit(db, actor, unitId, to, String(form.get("note") ?? "") || null);
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "equipment_transition", "equipment_unit", unitId, { from: r.before, to: r.after });
    return back("transitioned", r.after);
  }

  /* ── Admin-only: catalog + unit record changes ── */
  if (user!.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });

  if (action === "create_model") {
    const r = await createModel(db, actor, modelInput(form));
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "create_equipment_model", "equipment_model", r.id);
    return back("created", "model");
  }

  if (action === "update_model") {
    const modelId = String(form.get("model_id") ?? "");
    if (!UUID_RE.test(modelId)) return fail("Invalid model.");
    const r = await updateModel(db, modelId, modelInput(form));
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "update_equipment_model", "equipment_model", modelId);
    return back("updated");
  }

  if (action === "create_unit") {
    const r = await createUnit(db, actor, unitInput(form));
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "create_equipment_unit", "equipment_unit", r.id);
    return back("created", "unit");
  }

  if (action === "update_unit") {
    const unitId = String(form.get("unit_id") ?? "");
    if (!UUID_RE.test(unitId)) return fail("Invalid unit.");
    const r = await updateUnit(db, unitId, unitInput(form, true));
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "update_equipment_unit", "equipment_unit", unitId);
    return back("updated");
  }

  if (action === "assign_venue") {
    const unitId = String(form.get("unit_id") ?? "");
    const venueId = String(form.get("venue_id") ?? "") || null;
    if (!UUID_RE.test(unitId) || (venueId && !UUID_RE.test(venueId))) return fail("Invalid unit or venue.");
    const r = await updateUnit(db, unitId, { venue_id: venueId });
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "assign_equipment_venue", "equipment_unit", unitId, { venue_id: venueId });
    return back("assigned", "Venue saved.");
  }

  if (action === "link_kiosk") {
    const unitId = String(form.get("unit_id") ?? "");
    const kioskId = String(form.get("kiosk_id") ?? "") || null;
    if (!UUID_RE.test(unitId) || (kioskId && !UUID_RE.test(kioskId))) return fail("Invalid unit or kiosk.");
    const r = await updateUnit(db, unitId, { kiosk_id: kioskId });
    if (!r.ok) return fail(r.error);
    await auditLog(actor, "link_equipment_kiosk", "equipment_unit", unitId, { kiosk_id: kioskId });
    return back("linked", "Kiosk link saved.");
  }

  return fail("Unknown equipment action.");
}
