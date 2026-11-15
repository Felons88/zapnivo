import type { SupabaseClient } from "@supabase/supabase-js";
import { EQUIPMENT_CATEGORIES, EQUIPMENT_LABELS } from "./equipment";

/**
 * Vending equipment catalog + physical-unit fleet — server-only (service client).
 *
 * Models (equipment_models) describe what we can buy; units (equipment_units) are
 * the physical machines. Charger units may link an existing kiosk row
 * (equipment_units.kiosk_id → kiosks.id) so there is one device identity — the
 * kiosk stays the live-telemetry record, the unit is the asset/lifecycle record.
 *
 * Lifecycle (forward spine, mirrors the CHECK constraint + comment in 0071):
 *   planned → sourcing → ordered → received → inspected → available
 *   → assigned → installed → active → maintenance → retired
 *
 * Deliberate choices, documented:
 *  - Every non-terminal status may move to `retired` (a unit can be scrapped or
 *    returned at any point before it is retired); `retired` is terminal.
 *  - `maintenance` may return to `active` (field-repaired units go straight back
 *    into service) or `installed` (pulled mid-install, re-installed later);
 *    `installed → maintenance` covers a deployed unit that needs bench work.
 *  - `assigned → available` releases a unit back to the warehouse pool;
 *    `available → assigned` is the only pool-out move (venue assignment is a
 *    data field updated separately — it does not itself advance the lifecycle).
 *  - Timestamps are set when ENTERING `installed` / `retired` and are never
 *    unset on a reverse move (installed_at records the first install; a unit
 *    that goes active→maintenance→active keeps its original install date).
 *  - There is no direct `available → installed`: a unit must be assigned to a
 *    venue first so installs always have a destination on record.
 */

export const EQUIPMENT_MODEL_CATEGORIES = [...EQUIPMENT_CATEGORIES, "combo"] as const;
export type EquipmentModelCategory = (typeof EQUIPMENT_MODEL_CATEGORIES)[number];
export const isModelCategory = (s: string): s is EquipmentModelCategory =>
  (EQUIPMENT_MODEL_CATEGORIES as readonly string[]).includes(s);

export const MODEL_CATEGORY_LABELS: Record<EquipmentModelCategory, string> = {
  ...EQUIPMENT_LABELS,
  combo: "Combo / multi-category",
} as Record<EquipmentModelCategory, string>;

export const EQUIPMENT_LIFECYCLE = [
  "planned", "sourcing", "ordered", "received", "inspected", "available",
  "assigned", "installed", "active", "maintenance", "retired",
] as const;
export type EquipmentStatus = (typeof EQUIPMENT_LIFECYCLE)[number];
export const isEquipmentStatus = (s: string): s is EquipmentStatus =>
  (EQUIPMENT_LIFECYCLE as readonly string[]).includes(s);

export const EQUIPMENT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  planned: "Planned", sourcing: "Sourcing", ordered: "Ordered", received: "Received",
  inspected: "Inspected", available: "Available", assigned: "Assigned",
  installed: "Installed", active: "Active", maintenance: "Maintenance", retired: "Retired",
};

const RETIRABLE = EQUIPMENT_LIFECYCLE.filter((s) => s !== "retired") as EquipmentStatus[];

/** Legal moves per status. `retired` is reachable from every non-terminal state. */
export const EQUIPMENT_TRANSITIONS: Record<EquipmentStatus, readonly EquipmentStatus[]> = {
  planned: ["sourcing", "retired"],
  sourcing: ["ordered", "planned", "retired"],
  ordered: ["received", "sourcing", "retired"],
  received: ["inspected", "ordered", "retired"],
  inspected: ["available", "received", "retired"],
  available: ["assigned", "retired"],
  assigned: ["installed", "available", "retired"],
  installed: ["active", "maintenance", "retired"],
  active: ["maintenance", "retired"],
  maintenance: ["active", "installed", "retired"],
  retired: [],
};

export const canTransition = (from: EquipmentStatus, to: EquipmentStatus): boolean =>
  (EQUIPMENT_TRANSITIONS[from] ?? []).includes(to);

export const nextStatuses = (from: EquipmentStatus): readonly EquipmentStatus[] => EQUIPMENT_TRANSITIONS[from] ?? [];

export const MODEL_STATUSES = ["draft", "active", "discontinued"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];
export const isModelStatus = (s: string): s is ModelStatus => (MODEL_STATUSES as readonly string[]).includes(s);

export const UNIT_OWNERSHIP = ["company", "venue", "leased", "customer"] as const;
export type UnitOwnership = (typeof UNIT_OWNERSHIP)[number];
export const isUnitOwnership = (s: string): s is UnitOwnership => (UNIT_OWNERSHIP as readonly string[]).includes(s);

const nonNegInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export type TransitionPatch = { ok: true; patch: Record<string, unknown> } | { ok: false; error: string };

/**
 * Pure patch builder for a legal unit transition. Sets installed_at when entering
 * `installed` and retired_at when entering `retired`; never unsets them on reverse
 * moves. `now` is injectable for tests.
 */
export function transitionPatch(from: EquipmentStatus, to: EquipmentStatus, now = new Date()): TransitionPatch {
  if (!isEquipmentStatus(from) || !isEquipmentStatus(to)) return { ok: false, error: "Unknown equipment status." };
  if (!canTransition(from, to)) return { ok: false, error: `A ${from} unit cannot move to ${to}.` };
  const patch: Record<string, unknown> = { status: to };
  if (to === "installed") patch.installed_at = now.toISOString();
  if (to === "retired") patch.retired_at = now.toISOString();
  return { ok: true, patch };
}

export type TransitionResult =
  | { ok: true; before: EquipmentStatus; after: EquipmentStatus }
  | { ok: false; status: number; error: string };

/**
 * Applies a legal lifecycle transition with an optimistic status guard
 * (`.eq("status", before)`), then appends an equipment_lifecycle_events row.
 * Callers own authorization and auditLog — this only enforces lifecycle legality.
 */
export async function transitionUnit(
  db: SupabaseClient,
  actor: string | null,
  unitId: string,
  to: EquipmentStatus,
  note?: string | null,
  now = new Date(),
): Promise<TransitionResult> {
  const { data: row } = await db.from("equipment_units").select("id,status").eq("id", unitId).maybeSingle();
  const before = (row as { status?: string } | null)?.status;
  if (!row || !before || !isEquipmentStatus(before)) return { ok: false, status: 404, error: "Equipment unit not found." };
  const built = transitionPatch(before, to, now);
  if (!built.ok) return { ok: false, status: 409, error: built.error };
  const { data: upd, error } = await db
    .from("equipment_units")
    .update(built.patch)
    .eq("id", unitId)
    .eq("status", before)
    .select("id,status")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Couldn't update the unit." };
  if (!upd) return { ok: false, status: 409, error: "Unit changed while updating — refresh and retry." };
  const { error: evErr } = await db.from("equipment_lifecycle_events").insert({
    unit_id: unitId,
    from_status: before,
    to_status: (upd as { status: EquipmentStatus }).status,
    actor: actor && /^[0-9a-f-]{36}$/i.test(actor) ? actor : null,
    note: note?.trim() ? note.trim().slice(0, 500) : null,
  });
  if (evErr) return { ok: false, status: 500, error: "Status changed but the lifecycle event could not be recorded — check the audit trail." };
  return { ok: true, before, after: (upd as { status: EquipmentStatus }).status };
}

/* ─── Catalog + unit CRUD helpers ─────────────────────────────────────────── */

export type ModelInput = {
  category?: string; manufacturer?: string | null; model_name?: string;
  capacity_description?: string | null; dimensions?: string | null;
  acquisition_cost_cents?: unknown; supplier?: string | null;
  warranty_months?: unknown; connectivity?: string | null;
  status?: string; notes?: string | null;
};

const strOrNull = (v: unknown, max = 2000): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

function modelFields(input: ModelInput): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  const category = strOrNull(input.category, 40) ?? "";
  if (!isModelCategory(category)) return { ok: false, error: `Category must be one of: ${EQUIPMENT_MODEL_CATEGORIES.join(", ")}.` };
  const modelName = strOrNull(input.model_name, 160);
  if (!modelName) return { ok: false, error: "Model name is required." };
  const cost = nonNegInt(input.acquisition_cost_cents);
  if (input.acquisition_cost_cents !== null && input.acquisition_cost_cents !== undefined && input.acquisition_cost_cents !== "" && cost === null) {
    return { ok: false, error: "Acquisition cost must be a whole number of cents ≥ 0." };
  }
  const warranty = nonNegInt(input.warranty_months);
  if (input.warranty_months !== null && input.warranty_months !== undefined && input.warranty_months !== "" && warranty === null) {
    return { ok: false, error: "Warranty must be a whole number of months ≥ 0." };
  }
  const status = strOrNull(input.status, 20) ?? "draft";
  if (!isModelStatus(status)) return { ok: false, error: `Status must be one of: ${MODEL_STATUSES.join(", ")}.` };
  return {
    ok: true,
    fields: {
      category, model_name: modelName,
      manufacturer: strOrNull(input.manufacturer, 160),
      capacity_description: strOrNull(input.capacity_description),
      dimensions: strOrNull(input.dimensions, 200),
      acquisition_cost_cents: cost,
      supplier: strOrNull(input.supplier, 160),
      warranty_months: warranty,
      connectivity: strOrNull(input.connectivity, 500),
      status,
      notes: strOrNull(input.notes),
    },
  };
}

export type CrudResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export async function createModel(db: SupabaseClient, actor: string | null, input: ModelInput): Promise<CrudResult> {
  const built = modelFields(input);
  if (!built.ok) return { ok: false, status: 422, error: built.error };
  const { data, error } = await db.from("equipment_models").insert({
    ...built.fields,
    created_by: actor && /^[0-9a-f-]{36}$/i.test(actor) ? actor : null,
  }).select("id").single();
  if (error || !data) return { ok: false, status: 500, error: "The model could not be created." };
  return { ok: true, id: (data as { id: string }).id };
}

export async function updateModel(db: SupabaseClient, modelId: string, input: ModelInput): Promise<CrudResult> {
  const built = modelFields(input);
  if (!built.ok) return { ok: false, status: 422, error: built.error };
  const { data, error } = await db.from("equipment_models").update(built.fields).eq("id", modelId).select("id").maybeSingle();
  if (error) return { ok: false, status: 500, error: "The model could not be updated." };
  if (!data) return { ok: false, status: 404, error: "Model not found." };
  return { ok: true, id: modelId };
}

export type UnitInput = {
  model_id?: string | null; serial_number?: string | null; category?: string;
  kiosk_id?: string | null; venue_id?: string | null; ownership?: string;
  cost_cents?: unknown; manufacturer?: string | null; model_label?: string | null;
  service_schedule?: string | null; notes?: string | null;
};

const UUID_RE = /^[0-9a-f-]{36}$/i;

function unitFields(input: UnitInput): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  const category = strOrNull(input.category, 40) ?? "";
  if (!isModelCategory(category)) return { ok: false, error: `Category must be one of: ${EQUIPMENT_MODEL_CATEGORIES.join(", ")}.` };
  const ownership = strOrNull(input.ownership, 20) ?? "company";
  if (!isUnitOwnership(ownership)) return { ok: false, error: `Ownership must be one of: ${UNIT_OWNERSHIP.join(", ")}.` };
  const cost = nonNegInt(input.cost_cents);
  if (input.cost_cents !== null && input.cost_cents !== undefined && input.cost_cents !== "" && cost === null) {
    return { ok: false, error: "Cost must be a whole number of cents ≥ 0." };
  }
  for (const key of ["model_id", "kiosk_id", "venue_id"] as const) {
    const v = input[key];
    if (v !== null && v !== undefined && v !== "" && !UUID_RE.test(String(v))) return { ok: false, error: `Invalid ${key}.` };
  }
  // Only charger stations link a live kiosk device record.
  if (category !== "charger_station" && input.kiosk_id) return { ok: false, error: "Only charger_station units can link a kiosk." };
  return {
    ok: true,
    fields: {
      category, ownership,
      model_id: strOrNull(input.model_id) && UUID_RE.test(String(input.model_id)) ? String(input.model_id) : null,
      serial_number: strOrNull(input.serial_number, 120),
      kiosk_id: category === "charger_station" && input.kiosk_id && UUID_RE.test(String(input.kiosk_id)) ? String(input.kiosk_id) : null,
      venue_id: input.venue_id && UUID_RE.test(String(input.venue_id)) ? String(input.venue_id) : null,
      cost_cents: cost,
      manufacturer: strOrNull(input.manufacturer, 160),
      model_label: strOrNull(input.model_label, 160),
      service_schedule: strOrNull(input.service_schedule, 500),
      notes: strOrNull(input.notes),
    },
  };
}

const friendlyInsertError = (error: { code?: string; message?: string } | null): string =>
  error?.code === "23505" || /duplicate key|unique/i.test(error?.message ?? "")
    ? "That serial number is already in use — pick a unique serial."
    : "The unit could not be saved.";

const UNIT_INPUT_KEYS = [
  "model_id", "serial_number", "category", "kiosk_id", "venue_id", "ownership",
  "cost_cents", "manufacturer", "model_label", "service_schedule", "notes",
] as const;

export async function createUnit(db: SupabaseClient, actor: string | null, input: UnitInput): Promise<CrudResult> {
  const built = unitFields(input);
  if (!built.ok) return { ok: false, status: 422, error: built.error };
  const { data, error } = await db.from("equipment_units").insert({
    ...built.fields,
    status: "planned",
    created_by: actor && UUID_RE.test(actor) ? actor : null,
  }).select("id").single();
  if (error || !data) return { ok: false, status: error?.code === "23505" ? 409 : 500, error: friendlyInsertError(error) };
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Partial update: only keys actually present on `input` are patched, so a small
 * form (e.g. venue assignment) can't wipe fields it doesn't render. The merged
 * row is still fully validated first. Status is never patchable here — lifecycle
 * moves go through transitionUnit.
 */
export async function updateUnit(db: SupabaseClient, unitId: string, input: UnitInput): Promise<CrudResult> {
  const { data: existing } = await db.from("equipment_units").select("*").eq("id", unitId).maybeSingle();
  if (!existing) return { ok: false, status: 404, error: "Equipment unit not found." };
  const ex = existing as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const k of UNIT_INPUT_KEYS) merged[k] = ex[k] ?? null;
  const provided = new Set<string>();
  for (const k of UNIT_INPUT_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined) { merged[k] = v; provided.add(k); }
  }
  const built = unitFields(merged as UnitInput);
  if (!built.ok) return { ok: false, status: 422, error: built.error };
  const patch: Record<string, unknown> = {};
  for (const k of provided) patch[k] = built.fields[k];
  if (Object.keys(patch).length === 0) return { ok: false, status: 422, error: "Nothing to update." };
  const { data, error } = await db.from("equipment_units").update(patch).eq("id", unitId).select("id").maybeSingle();
  if (error) return { ok: false, status: error?.code === "23505" ? 409 : 500, error: friendlyInsertError(error) };
  if (!data) return { ok: false, status: 404, error: "Equipment unit not found." };
  return { ok: true, id: unitId };
}

/* ─── Admin board loader ──────────────────────────────────────────────────── */

export type BoardUnit = {
  id: string; serial_number: string | null; category: string; status: EquipmentStatus;
  model_id: string | null; kiosk_id: string | null; venue_id: string | null;
  ownership: string; cost_cents: number | null; manufacturer: string | null;
  model_label: string | null; service_schedule: string | null; notes: string | null;
  installed_at: string | null; retired_at: string | null; created_at: string | null;
  model: { model_name: string; manufacturer: string | null; category: string } | null;
  venue: { name: string } | null;
  kiosk: { station_id: string } | null;
};

export type BoardModel = {
  id: string; category: string; manufacturer: string | null; model_name: string;
  capacity_description: string | null; dimensions: string | null;
  acquisition_cost_cents: number | null; supplier: string | null;
  warranty_months: number | null; connectivity: string | null;
  status: string; notes: string | null;
};

export type EquipmentBoard = {
  unavailable: boolean;
  models: BoardModel[];
  units: BoardUnit[];
  venues: { id: string; name: string; city: string | null }[];
  kiosks: { id: string; station_id: string }[];
  counts: { byStatus: Partial<Record<EquipmentStatus, number>>; byCategory: Record<string, number>; total: number };
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/**
 * Loads the full equipment board for /admin/equipment. Any failure returns
 * { unavailable: true } with empty lists — the page renders an honest empty state
 * rather than fabricating a fleet.
 */
export async function loadEquipmentBoard(db: SupabaseClient): Promise<EquipmentBoard> {
  const empty: EquipmentBoard = {
    unavailable: true, models: [], units: [], venues: [], kiosks: [],
    counts: { byStatus: {}, byCategory: {}, total: 0 },
  };
  try {
    const [models, units, venues, kiosks] = await Promise.all([
      db.from("equipment_models").select("id,category,manufacturer,model_name,capacity_description,dimensions,acquisition_cost_cents,supplier,warranty_months,connectivity,status,notes").order("created_at", { ascending: false }).limit(500),
      db.from("equipment_units")
        .select("id,serial_number,category,status,model_id,kiosk_id,venue_id,ownership,cost_cents,manufacturer,model_label,service_schedule,notes,installed_at,retired_at,created_at,equipment_models(model_name,manufacturer,category),venues(name),kiosks(station_id)")
        .order("created_at", { ascending: false }).limit(1000),
      db.from("venues").select("id,name,city").order("name").limit(500),
      db.from("kiosks").select("id,station_id").order("created_at", { ascending: false }).limit(500),
    ]);
    if (models.error || units.error || venues.error || kiosks.error) return empty;

    const modelRows = (models.data ?? []) as unknown as BoardModel[];
    const unitRows = (units.data ?? []) as unknown as (Omit<BoardUnit, "model" | "venue" | "kiosk"> & {
      equipment_models: BoardUnit["model"] | BoardUnit["model"][] | null;
      venues: { name: string } | { name: string }[] | null;
      kiosks: { station_id: string } | { station_id: string }[] | null;
    })[];
    const unitsFlat: BoardUnit[] = unitRows.map((u) => ({
      ...u,
      model: one(u.equipment_models),
      venue: one(u.venues),
      kiosk: one(u.kiosks),
    }));
    const venueRows = (venues.data ?? []) as { id: string; name: string; city: string | null }[];
    const kioskRows = (kiosks.data ?? []) as { id: string; station_id: string }[];

    const byStatus: Partial<Record<EquipmentStatus, number>> = {};
    const byCategory: Record<string, number> = {};
    for (const u of unitsFlat) {
      if (isEquipmentStatus(u.status)) byStatus[u.status] = (byStatus[u.status] ?? 0) + 1;
      byCategory[u.category] = (byCategory[u.category] ?? 0) + 1;
    }
    return {
      unavailable: false,
      models: modelRows,
      units: unitsFlat,
      venues: venueRows,
      kiosks: kioskRows,
      counts: { byStatus, byCategory, total: unitsFlat.length },
    };
  } catch {
    return empty;
  }
}

export { RETIRABLE as EQUIPMENT_RETIRABLE_STATUSES };
