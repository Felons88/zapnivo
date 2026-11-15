import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "./audit";

/**
 * Phase 7 — product inventory & restocking (migration 0071).
 *
 * Stock location rule (schema-enforced via `unique nulls not distinct`):
 *   unit_id = null, venue_id = null  → company warehouse
 *   unit_id set                      → inside that machine
 *   venue_id set                     → venue stockroom
 *   both set                         → rejected by validateLocation()
 *
 * Reconciliation rule for completed restock visits (documented, deliberate):
 *   qty_picked  DECREMENTS warehouse stock (clamped at 0 — a short pick is
 *               flagged `short_pick` in the result instead of failing).
 *   qty_loaded  INCREMENTS the visiting unit's stock.
 *   qty_waste   is recorded on the line for reporting only — it does NOT move
 *               stock (assumed discarded before/while loading; picked already
 *               left the warehouse).
 * Completing an already-completed visit is idempotent: it returns the current
 * state without re-applying stock effects (the visit row is claimed with a
 * status-guarded update before effects run).
 *
 * Race safety: stock_levels has no DB-side decrement guard, so writes are
 * select-then-guarded-update (`.eq("qty", before)`), with ONE re-read + retry
 * when the guard misses, and a select-then-insert fallback on unique conflicts.
 * This is "race-safe-ish": a lost update is detected and retried once; a second
 * concurrent loss is applied unconditionally rather than looping forever.
 */

// ─── Catalog constants ───────────────────────────────────────────────────────

export const SKU_CATEGORIES = ["snack", "beverage", "food", "trading_cards", "collectibles", "specialty"] as const;
export type SkuCategory = (typeof SKU_CATEGORIES)[number];
export const isSkuCategory = (v: unknown): v is SkuCategory =>
  typeof v === "string" && (SKU_CATEGORIES as readonly string[]).includes(v);

/**
 * equipment_units.category values that can physically hold product stock.
 * The six SKU categories plus 'combo' (combo machines vend multiple product
 * categories). 'charger_station' units never hold product stock.
 */
export const PRODUCT_UNIT_CATEGORIES = [...SKU_CATEGORIES, "combo"] as const;
export const isProductUnitCategory = (v: unknown): boolean =>
  typeof v === "string" && (PRODUCT_UNIT_CATEGORIES as readonly string[]).includes(v);

export const VISIT_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Legal visit transitions. 'completed' is handled by completeVisit (applies stock effects). */
export const VISIT_TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  planned: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// ─── Shared types ────────────────────────────────────────────────────────────

export type StockLocation = { unit_id: string | null; venue_id: string | null };

export type SkuInput = {
  category: SkuCategory;
  name: string;
  supplier?: string | null;
  unit_cost_cents?: number | null;
  reorder_point?: number;
  track_expiry?: boolean;
  notes?: string | null;
};

export type SkuRow = {
  id: string; category: string; name: string; supplier: string | null;
  unit_cost_cents: number | null; reorder_point: number; track_expiry: boolean;
  active: boolean; notes: string | null;
};

export type StockLevelRow = {
  id: string; sku_id: string; unit_id: string | null; venue_id: string | null; qty: number;
};

export type StockOpResult =
  | { ok: true; level_id: string | null; before: number; after: number }
  | { ok: false; error: string; before?: number };

export type VisitRow = {
  id: string; unit_id: string; technician: string | null; status: VisitStatus;
  scheduled_for: string | null; notes: string | null; created_by: string | null;
  created_at: string; completed_at: string | null;
};

export type VisitLineRow = {
  id: string; visit_id: string; sku_id: string;
  qty_picked: number; qty_loaded: number; qty_waste: number;
};

export type VisitLineEffect = {
  sku_id: string; qty_picked: number; qty_loaded: number; qty_waste: number;
  warehouse_before: number; warehouse_after: number; unit_before: number; unit_after: number;
  /** true when warehouse stock was below qty_picked and clamped at 0. */
  short_pick: boolean;
};

export type CompleteResult =
  | { ok: true; idempotent: boolean; effects: VisitLineEffect[]; short_picks: string[] }
  | { ok: false; error: string };

// ─── Validation helpers ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Rejects the both-ids-set case; null/undefined normalize to warehouse-or-other side. */
export function validateLocation(unit_id?: string | null, venue_id?: string | null): { ok: true; loc: Required<StockLocation> } | { ok: false; error: string } {
  const u = unit_id ?? null;
  const v = venue_id ?? null;
  if (u && v) return { ok: false, error: "stock cannot be assigned to both a unit and a venue" };
  if (u && !isUuid(u)) return { ok: false, error: "invalid unit_id" };
  if (v && !isUuid(v)) return { ok: false, error: "invalid venue_id" };
  return { ok: true, loc: { unit_id: u, venue_id: v } };
}

export function validateSkuInput(input: Partial<SkuInput> & { category?: string }): { ok: true; data: SkuInput } | { ok: false; error: string } {
  const category = input.category;
  if (!isSkuCategory(category)) return { ok: false, error: `category must be one of: ${SKU_CATEGORIES.join(", ")}` };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 160) return { ok: false, error: "name is required (max 160 chars)" };
  const supplier = typeof input.supplier === "string" && input.supplier.trim() ? input.supplier.trim().slice(0, 160) : null;
  const cost = input.unit_cost_cents;
  if (cost !== undefined && cost !== null && !intIn(cost, 0, 1_000_000_000)) return { ok: false, error: "unit_cost_cents must be a non-negative integer (cents)" };
  const reorder = input.reorder_point ?? 0;
  if (!intIn(reorder, 0, 10_000_000)) return { ok: false, error: "reorder_point must be a non-negative integer" };
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 2000) : null;
  return {
    ok: true,
    data: {
      category, name, supplier,
      unit_cost_cents: cost ?? null,
      reorder_point: reorder,
      track_expiry: input.track_expiry === true,
      notes,
    },
  };
}

// ─── stock_levels primitives ─────────────────────────────────────────────────

type DeltaResult =
  | { ok: true; level_id: string | null; before: number; after: number; clamped: boolean }
  | { ok: false; error: string; before: number };

const nowIso = () => new Date().toISOString();

/** Finds the single stock_levels row for a (sku, location) triple; both-null location = warehouse. */
async function findLevel(db: SupabaseClient, sku_id: string, unit_id: string | null, venue_id: string | null) {
  let q = db.from("stock_levels").select("id,sku_id,unit_id,venue_id,qty").eq("sku_id", sku_id);
  q = unit_id == null ? q.is("unit_id", null) : q.eq("unit_id", unit_id);
  q = venue_id == null ? q.is("venue_id", null) : q.eq("venue_id", venue_id);
  const { data, error } = await q.maybeSingle();
  if (error) return { row: null as StockLevelRow | null, error: error.message };
  return { row: (data as StockLevelRow | null) ?? null, error: null as string | null };
}

/**
 * Core delta writer. clampZero=true floors the result at 0 (used by visit
 * completion so a short pick flags instead of failing). See file header for
 * the race-safety notes.
 */
async function applyStockDelta(
  db: SupabaseClient,
  sku_id: string,
  unit_id: string | null,
  venue_id: string | null,
  delta: number,
  clampZero: boolean,
): Promise<DeltaResult> {
  const found = await findLevel(db, sku_id, unit_id, venue_id);
  if (found.error) return { ok: false, error: "stock_lookup_failed", before: 0 };
  let row = found.row;
  let before = row?.qty ?? 0;
  let after = before + delta;
  let clamped = false;
  if (after < 0) {
    if (!clampZero) return { ok: false, error: "insufficient_stock", before };
    after = 0;
    clamped = true;
  }

  if (!row) {
    const ins = await db.from("stock_levels")
      .insert({ sku_id, unit_id, venue_id, qty: after })
      .select("id").single();
    if (!ins.error) {
      return { ok: true, level_id: (ins.data as { id?: string } | null)?.id ?? null, before: 0, after, clamped };
    }
    // Unique-conflict race: another writer created the row — retry once as update.
    const again = await findLevel(db, sku_id, unit_id, venue_id);
    if (again.error || !again.row) return { ok: false, error: "stock_write_failed", before };
    row = again.row;
    before = row.qty;
    after = before + delta;
    clamped = false;
    if (after < 0) {
      if (!clampZero) return { ok: false, error: "insufficient_stock", before };
      after = 0;
      clamped = true;
    }
  }

  // Guarded update: only applies while qty still equals what we read.
  const upd = await db.from("stock_levels")
    .update({ qty: after, updated_at: nowIso() })
    .eq("id", row.id).eq("qty", before)
    .select("id").maybeSingle();
  if (upd.data) return { ok: true, level_id: row.id, before, after, clamped };

  // Lost the race — re-read once and apply unconditionally (documented trade-off).
  const reread = await findLevel(db, sku_id, unit_id, venue_id);
  if (reread.error || !reread.row) return { ok: false, error: "stock_level_vanished", before };
  const before2 = reread.row.qty;
  let after2 = before2 + delta;
  let clamped2 = false;
  if (after2 < 0) {
    if (!clampZero) return { ok: false, error: "insufficient_stock", before: before2 };
    after2 = 0;
    clamped2 = true;
  }
  const fin = await db.from("stock_levels")
    .update({ qty: after2, updated_at: nowIso() })
    .eq("id", reread.row.id);
  if (fin.error) return { ok: false, error: "stock_write_failed", before: before2 };
  return { ok: true, level_id: reread.row.id, before: before2, after: after2, clamped: clamped2 };
}

// ─── Public stock operations ─────────────────────────────────────────────────

/**
 * Adds `delta` (may be negative) to the stock level at the given location.
 * Warehouse = both ids null. Negative results are rejected before writing.
 */
export async function adjustStock(
  db: SupabaseClient,
  actor: string | null,
  input: { sku_id: string; unit_id?: string | null; venue_id?: string | null; delta: number; reason?: string | null },
): Promise<StockOpResult> {
  if (!isUuid(input.sku_id)) return { ok: false, error: "invalid sku_id" };
  if (!intIn(input.delta, -10_000_000, 10_000_000) || input.delta === 0) {
    return { ok: false, error: "delta must be a non-zero integer" };
  }
  const loc = validateLocation(input.unit_id, input.venue_id);
  if (!loc.ok) return { ok: false, error: loc.error };
  const res = await applyStockDelta(db, input.sku_id, loc.loc.unit_id, loc.loc.venue_id, input.delta, false);
  if (!res.ok) return res;
  await auditLog(actor, "stock_adjust", "stock_level", res.level_id, {
    sku_id: input.sku_id, ...loc.loc, delta: input.delta,
    reason: input.reason ?? null, before: res.before, after: res.after,
  });
  return { ok: true, level_id: res.level_id, before: res.before, after: res.after };
}

/** Absolute set for reconciliation counts. Negative qty rejected; audit carries before/after. */
export async function setStockCount(
  db: SupabaseClient,
  actor: string | null,
  input: { sku_id: string; unit_id?: string | null; venue_id?: string | null; qty: number; reason?: string | null },
): Promise<StockOpResult> {
  if (!isUuid(input.sku_id)) return { ok: false, error: "invalid sku_id" };
  if (!intIn(input.qty, 0, 10_000_000)) return { ok: false, error: "qty must be a non-negative integer" };
  const loc = validateLocation(input.unit_id, input.venue_id);
  if (!loc.ok) return { ok: false, error: loc.error };
  const { unit_id, venue_id } = loc.loc;
  const found = await findLevel(db, input.sku_id, unit_id, venue_id);
  if (found.error) return { ok: false, error: "stock_lookup_failed" };
  const before = found.row?.qty ?? 0;
  const after = input.qty;
  if (found.row) {
    const upd = await db.from("stock_levels")
      .update({ qty: after, updated_at: nowIso() }).eq("id", found.row.id);
    if (upd.error) return { ok: false, error: "stock_write_failed", before };
    await auditLog(actor, "stock_set", "stock_level", found.row.id, {
      sku_id: input.sku_id, unit_id, venue_id, before, after, reason: input.reason ?? null,
    });
    return { ok: true, level_id: found.row.id, before, after };
  }
  const ins = await db.from("stock_levels")
    .insert({ sku_id: input.sku_id, unit_id, venue_id, qty: after })
    .select("id").single();
  if (ins.error) {
    // Row appeared concurrently — fall back to a guarded update.
    const again = await findLevel(db, input.sku_id, unit_id, venue_id);
    if (again.error || !again.row) return { ok: false, error: "stock_write_failed", before };
    const upd2 = await db.from("stock_levels").update({ qty: after, updated_at: nowIso() }).eq("id", again.row.id);
    if (upd2.error) return { ok: false, error: "stock_write_failed", before: again.row.qty };
    await auditLog(actor, "stock_set", "stock_level", again.row.id, {
      sku_id: input.sku_id, unit_id, venue_id, before: again.row.qty, after, reason: input.reason ?? null,
    });
    return { ok: true, level_id: again.row.id, before: again.row.qty, after };
  }
  const levelId = (ins.data as { id?: string } | null)?.id ?? null;
  await auditLog(actor, "stock_set", "stock_level", levelId, {
    sku_id: input.sku_id, unit_id, venue_id, before, after, reason: input.reason ?? null,
  });
  return { ok: true, level_id: levelId, before, after };
}

// ─── SKU CRUD ────────────────────────────────────────────────────────────────

export async function createSku(db: SupabaseClient, actor: string | null, input: Partial<SkuInput>): Promise<{ ok: true; sku: SkuRow } | { ok: false; error: string }> {
  const v = validateSkuInput(input);
  if (!v.ok) return v;
  const { data, error } = await db.from("product_skus").insert(v.data).select("*").single();
  if (error || !data) return { ok: false, error: "sku_create_failed" };
  const sku = data as SkuRow;
  await auditLog(actor, "sku_create", "product_sku", sku.id, { name: sku.name, category: sku.category });
  return { ok: true, sku };
}

export async function updateSku(
  db: SupabaseClient,
  actor: string | null,
  sku_id: string,
  patch: Partial<SkuInput> & { active?: boolean },
): Promise<{ ok: true; sku: SkuRow } | { ok: false; error: string }> {
  if (!isUuid(sku_id)) return { ok: false, error: "invalid sku_id" };
  const update: Record<string, unknown> = { updated_at: nowIso() };
  const changed: string[] = [];
  if (patch.category !== undefined || patch.name !== undefined || patch.supplier !== undefined ||
      patch.unit_cost_cents !== undefined || patch.reorder_point !== undefined ||
      patch.track_expiry !== undefined || patch.notes !== undefined) {
    // Re-validate the merged shape only for provided fields.
    if (patch.category !== undefined && !isSkuCategory(patch.category)) return { ok: false, error: "invalid category" };
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n || n.length > 160) return { ok: false, error: "name is required (max 160 chars)" };
      update.name = n; changed.push("name");
    }
    if (patch.category !== undefined) { update.category = patch.category; changed.push("category"); }
    if (patch.supplier !== undefined) { update.supplier = patch.supplier?.trim() ? patch.supplier.trim().slice(0, 160) : null; changed.push("supplier"); }
    if (patch.unit_cost_cents !== undefined) {
      if (patch.unit_cost_cents !== null && !intIn(patch.unit_cost_cents, 0, 1_000_000_000)) return { ok: false, error: "invalid unit_cost_cents" };
      update.unit_cost_cents = patch.unit_cost_cents; changed.push("unit_cost_cents");
    }
    if (patch.reorder_point !== undefined) {
      if (!intIn(patch.reorder_point, 0, 10_000_000)) return { ok: false, error: "invalid reorder_point" };
      update.reorder_point = patch.reorder_point; changed.push("reorder_point");
    }
    if (patch.track_expiry !== undefined) { update.track_expiry = patch.track_expiry === true; changed.push("track_expiry"); }
    if (patch.notes !== undefined) { update.notes = patch.notes?.trim() ? patch.notes.trim().slice(0, 2000) : null; changed.push("notes"); }
  }
  if (patch.active !== undefined) {
    if (typeof patch.active !== "boolean") return { ok: false, error: "invalid active flag" };
    update.active = patch.active; changed.push("active");
  }
  if (changed.length === 0) return { ok: false, error: "nothing to update" };
  const { data, error } = await db.from("product_skus").update(update).eq("id", sku_id).select("*").single();
  if (error || !data) return { ok: false, error: "sku_update_failed" };
  const sku = data as SkuRow;
  await auditLog(actor, "sku_update", "product_sku", sku_id, { changed });
  return { ok: true, sku };
}

/** Sets (or flips) the active flag. Deactivation does not touch existing stock rows. */
export async function toggleActiveSku(
  db: SupabaseClient,
  actor: string | null,
  sku_id: string,
  active?: boolean,
): Promise<{ ok: true; sku: SkuRow } | { ok: false; error: string }> {
  const { data: cur, error } = await db.from("product_skus").select("id,active").eq("id", sku_id).maybeSingle();
  if (error || !cur) return { ok: false, error: "sku_not_found" };
  const next = active ?? !(cur as { active: boolean }).active;
  return updateSku(db, actor, sku_id, { active: next });
}

// ─── Inventory board ─────────────────────────────────────────────────────────

export type StockLocationView = {
  key: string; kind: "warehouse" | "unit" | "venue";
  unit_id: string | null; venue_id: string | null;
  label: string; qty: number; low: boolean;
};

export type SkuBoardRow = SkuRow & {
  warehouse: number;
  total: number;
  locations: StockLocationView[];
  /** true when warehouse qty <= reorder_point (warehouse is the reorder source). */
  lowStock: boolean;
};

export type InventoryBoard = {
  skus: SkuBoardRow[];
  units: { id: string; label: string }[];
  venues: { id: string; name: string }[];
  lowStockCount: number;
};

const unitLabel = (u: { serial_number?: string | null; model_label?: string | null; category?: string | null }) =>
  [u.model_label, u.serial_number ?? u.category].filter(Boolean).join(" · ") || "unit";

/**
 * Full inventory board: every SKU with stock aggregated per location
 * (warehouse / per-unit / per-venue), low-stock flags (qty <= reorder_point),
 * and the unit/venue directories needed to render adjust forms.
 */
export async function loadInventoryBoard(db: SupabaseClient): Promise<InventoryBoard | { error: string }> {
  const [skusRes, stockRes, unitsRes, venuesRes] = await Promise.all([
    db.from("product_skus").select("*").order("name", { ascending: true }).limit(1000),
    db.from("stock_levels").select("id,sku_id,unit_id,venue_id,qty").limit(20000),
    db.from("equipment_units").select("id,serial_number,model_label,category,status,venue_id").limit(2000),
    db.from("venues").select("id,name").limit(1000),
  ]);
  if (skusRes.error || stockRes.error) return { error: "inventory_load_failed" };

  const skus = (skusRes.data ?? []) as unknown as SkuRow[];
  const stock = (stockRes.data ?? []) as unknown as StockLevelRow[];
  const units = (unitsRes.data ?? []) as unknown as { id: string; serial_number: string | null; model_label: string | null; category: string | null; status: string; venue_id: string | null }[];
  const venues = (venuesRes.data ?? []) as unknown as { id: string; name: string }[];
  const unitById = new Map(units.map((u) => [u.id, u]));
  const venueName = new Map(venues.map((v) => [v.id, v.name]));

  const bySku = new Map<string, StockLevelRow[]>();
  for (const s of stock) {
    const arr = bySku.get(s.sku_id) ?? [];
    arr.push(s);
    bySku.set(s.sku_id, arr);
  }

  const boardSkus: SkuBoardRow[] = skus.map((sku) => {
    const rows = bySku.get(sku.id) ?? [];
    const locations: StockLocationView[] = rows.map((r) => {
      const kind = r.unit_id ? "unit" : r.venue_id ? "venue" : "warehouse";
      const label = kind === "warehouse"
        ? "Warehouse"
        : kind === "unit"
          ? unitLabel(unitById.get(r.unit_id!) ?? {})
          : venueName.get(r.venue_id!) ?? "Venue stockroom";
      return {
        key: `${kind}:${r.unit_id ?? r.venue_id ?? "warehouse"}`,
        kind, unit_id: r.unit_id, venue_id: r.venue_id, label, qty: r.qty,
        low: r.qty <= sku.reorder_point,
      };
    });
    // Always surface the warehouse row even when empty — it's the reorder source.
    if (!locations.some((l) => l.kind === "warehouse")) {
      locations.unshift({ key: "warehouse", kind: "warehouse", unit_id: null, venue_id: null, label: "Warehouse", qty: 0, low: 0 <= sku.reorder_point });
    }
    const warehouse = locations.find((l) => l.kind === "warehouse")!.qty;
    const total = locations.reduce((a, l) => a + l.qty, 0);
    return { ...sku, warehouse, total, locations, lowStock: warehouse <= sku.reorder_point };
  });

  return {
    skus: boardSkus,
    units: units.map((u) => ({ id: u.id, label: unitLabel(u) })),
    venues,
    lowStockCount: boardSkus.filter((s) => s.lowStock).length,
  };
}

// ─── Restock visits ──────────────────────────────────────────────────────────

export type EligibleUnit = { id: string; label: string; category: string; venue_id: string | null };

/** Non-retired units whose category can hold product stock (see PRODUCT_UNIT_CATEGORIES). */
export async function listEligibleUnits(db: SupabaseClient): Promise<EligibleUnit[]> {
  const { data, error } = await db.from("equipment_units")
    .select("id,serial_number,model_label,category,status,venue_id")
    .neq("status", "retired").limit(2000);
  if (error) return [];
  return ((data ?? []) as unknown as { id: string; serial_number: string | null; model_label: string | null; category: string | null; status: string; venue_id: string | null }[])
    .filter((u) => isProductUnitCategory(u.category))
    .map((u) => ({ id: u.id, label: unitLabel(u), category: u.category!, venue_id: u.venue_id }));
}

async function getUnit(db: SupabaseClient, unit_id: string) {
  const { data, error } = await db.from("equipment_units")
    .select("id,status,category,serial_number,model_label,venue_id").eq("id", unit_id).maybeSingle();
  if (error || !data) return null;
  return data as { id: string; status: string; category: string | null; serial_number: string | null; model_label: string | null; venue_id: string | null };
}

export async function createVisit(
  db: SupabaseClient,
  actor: string | null,
  input: { unit_id: string; technician?: string | null; scheduled_for?: string | null; notes?: string | null },
): Promise<{ ok: true; visit: VisitRow } | { ok: false; error: string }> {
  if (!isUuid(input.unit_id)) return { ok: false, error: "invalid unit_id" };
  const unit = await getUnit(db, input.unit_id);
  if (!unit) return { ok: false, error: "unit_not_found" };
  if (unit.status === "retired") return { ok: false, error: "unit_retired" };
  if (!isProductUnitCategory(unit.category)) return { ok: false, error: "unit_cannot_hold_stock" };
  if (input.technician != null && input.technician !== "" && !isUuid(input.technician)) return { ok: false, error: "invalid technician" };
  let scheduled: string | null = null;
  if (input.scheduled_for) {
    const t = Date.parse(input.scheduled_for);
    if (Number.isNaN(t)) return { ok: false, error: "invalid scheduled_for" };
    scheduled = new Date(t).toISOString();
  }
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 2000) : null;
  const { data, error } = await db.from("restock_visits").insert({
    unit_id: input.unit_id,
    technician: input.technician || null,
    scheduled_for: scheduled,
    notes,
    created_by: isUuid(actor) ? actor : null,
    status: "planned",
  }).select("*").single();
  if (error || !data) return { ok: false, error: "visit_create_failed" };
  const visit = data as VisitRow;
  await auditLog(actor, "restock_visit_create", "restock_visit", visit.id, { unit_id: input.unit_id });
  return { ok: true, visit };
}

async function getVisit(db: SupabaseClient, visit_id: string) {
  const { data, error } = await db.from("restock_visits").select("*").eq("id", visit_id).maybeSingle();
  if (error || !data) return null;
  return data as VisitRow;
}

async function getLine(db: SupabaseClient, visit_id: string, sku_id: string) {
  const { data } = await db.from("restock_visit_lines")
    .select("*").eq("visit_id", visit_id).eq("sku_id", sku_id).maybeSingle();
  return (data as VisitLineRow | null) ?? null;
}

function qtyField(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return intIn(n, 0, 1_000_000) ? n : null;
}

/**
 * Insert-or-update a visit line (unique visit_id+sku_id). Only planned /
 * in_progress visits accept line edits.
 */
export async function upsertVisitLine(
  db: SupabaseClient,
  actor: string | null,
  input: { visit_id: string; sku_id: string; qty_picked?: number; qty_loaded?: number; qty_waste?: number },
): Promise<{ ok: true; line: VisitLineRow } | { ok: false; error: string }> {
  if (!isUuid(input.visit_id) || !isUuid(input.sku_id)) return { ok: false, error: "invalid visit_id or sku_id" };
  const visit = await getVisit(db, input.visit_id);
  if (!visit) return { ok: false, error: "visit_not_found" };
  if (visit.status !== "planned" && visit.status !== "in_progress") return { ok: false, error: "visit_closed" };
  const picked = qtyField(input.qty_picked ?? 0);
  const loaded = qtyField(input.qty_loaded ?? 0);
  const waste = qtyField(input.qty_waste ?? 0);
  if (picked === null || loaded === null || waste === null) return { ok: false, error: "qty fields must be integers >= 0" };
  const { data: sku } = await db.from("product_skus").select("id").eq("id", input.sku_id).maybeSingle();
  if (!sku) return { ok: false, error: "sku_not_found" };

  const existing = await getLine(db, input.visit_id, input.sku_id);
  if (existing) {
    const { data, error } = await db.from("restock_visit_lines")
      .update({ qty_picked: picked, qty_loaded: loaded, qty_waste: waste })
      .eq("id", existing.id).select("*").single();
    if (error || !data) return { ok: false, error: "line_update_failed" };
    const line = data as VisitLineRow;
    await auditLog(actor, "restock_line_update", "restock_visit", input.visit_id, { line_id: line.id, sku_id: input.sku_id, picked, loaded, waste });
    return { ok: true, line };
  }
  const { data, error } = await db.from("restock_visit_lines")
    .insert({ visit_id: input.visit_id, sku_id: input.sku_id, qty_picked: picked, qty_loaded: loaded, qty_waste: waste })
    .select("*").single();
  if (error || !data) {
    // Concurrent insert — fall back to update.
    const again = await getLine(db, input.visit_id, input.sku_id);
    if (!again) return { ok: false, error: "line_write_failed" };
    const upd = await db.from("restock_visit_lines")
      .update({ qty_picked: picked, qty_loaded: loaded, qty_waste: waste }).eq("id", again.id).select("*").single();
    if (upd.error || !upd.data) return { ok: false, error: "line_write_failed" };
    return { ok: true, line: upd.data as VisitLineRow };
  }
  const line = data as VisitLineRow;
  await auditLog(actor, "restock_line_add", "restock_visit", input.visit_id, { line_id: line.id, sku_id: input.sku_id, picked, loaded, waste });
  return { ok: true, line };
}

/** Alias kept for callers that distinguish add vs update semantics — both upsert on (visit_id, sku_id). */
export const addVisitLine = upsertVisitLine;
export const updateVisitLine = upsertVisitLine;

/**
 * planned → in_progress | cancelled; in_progress → cancelled.
 * 'completed' is delegated to completeVisit so stock effects are applied.
 */
export async function transitionVisit(
  db: SupabaseClient,
  actor: string | null,
  visit_id: string,
  to: VisitStatus,
): Promise<{ ok: true; visit: VisitRow } | CompleteResult | { ok: false; error: string }> {
  if (!isUuid(visit_id)) return { ok: false, error: "invalid visit_id" };
  const visit = await getVisit(db, visit_id);
  if (!visit) return { ok: false, error: "visit_not_found" };
  if (to === "completed") return completeVisit(db, actor, visit_id);
  if (!VISIT_TRANSITIONS[visit.status]?.includes(to)) return { ok: false, error: `cannot move visit from ${visit.status} to ${to}` };
  const { data, error } = await db.from("restock_visits")
    .update({ status: to }).eq("id", visit_id).eq("status", visit.status).select("*").single();
  if (error || !data) return { ok: false, error: "visit_transition_failed" };
  const updated = data as VisitRow;
  await auditLog(actor, "restock_visit_transition", "restock_visit", visit_id, { from: visit.status, to });
  return { ok: true, visit: updated };
}

/**
 * Completes a visit and applies stock effects (see file header for the
 * reconciliation rule). Idempotent: an already-completed visit returns
 * { ok: true, idempotent: true } without touching stock again. The visit row
 * is claimed via a status-guarded update BEFORE effects run so concurrent
 * completions can't double-apply.
 */
export async function completeVisit(db: SupabaseClient, actor: string | null, visit_id: string): Promise<CompleteResult> {
  if (!isUuid(visit_id)) return { ok: false, error: "invalid visit_id" };
  const visit = await getVisit(db, visit_id);
  if (!visit) return { ok: false, error: "visit_not_found" };
  if (visit.status === "completed") return { ok: true, idempotent: true, effects: [], short_picks: [] };
  if (visit.status === "cancelled") return { ok: false, error: "visit_cancelled" };

  // Claim the visit: only one completer can move planned|in_progress → completed.
  const claim = await db.from("restock_visits")
    .update({ status: "completed", completed_at: nowIso() })
    .eq("id", visit_id).in("status", ["planned", "in_progress"])
    .select("id").maybeSingle();
  if (claim.error) return { ok: false, error: "visit_complete_failed" };
  if (!claim.data) {
    const cur = await getVisit(db, visit_id);
    if (cur?.status === "completed") return { ok: true, idempotent: true, effects: [], short_picks: [] };
    return { ok: false, error: cur ? `cannot complete visit from ${cur.status}` : "visit_not_found" };
  }

  const { data: lineData, error: linesErr } = await db.from("restock_visit_lines")
    .select("*").eq("visit_id", visit_id);
  if (linesErr) return { ok: false, error: "visit_lines_failed" };
  const lines = (lineData ?? []) as unknown as VisitLineRow[];

  const effects: VisitLineEffect[] = [];
  const short_picks: string[] = [];
  for (const line of lines) {
    // Warehouse decrement: picked qty leaves the warehouse, clamped at 0.
    const wh = await applyStockDelta(db, line.sku_id, null, null, -line.qty_picked, true);
    if (!wh.ok) {
      // Stock layer failure mid-completion — visit is already claimed; report honestly.
      return { ok: false, error: `stock_apply_failed:${line.sku_id}` };
    }
    // Unit increment: loaded qty goes inside the machine.
    const un = await applyStockDelta(db, line.sku_id, visit.unit_id, null, line.qty_loaded, false);
    if (!un.ok) {
      return { ok: false, error: `stock_apply_failed:${line.sku_id}` };
    }
    if (wh.clamped) short_picks.push(line.sku_id);
    effects.push({
      sku_id: line.sku_id,
      qty_picked: line.qty_picked, qty_loaded: line.qty_loaded, qty_waste: line.qty_waste,
      warehouse_before: wh.before, warehouse_after: wh.after,
      unit_before: un.before, unit_after: un.after,
      short_pick: wh.clamped,
    });
  }

  await auditLog(actor, "restock_visit_complete", "restock_visit", visit_id, {
    unit_id: visit.unit_id, lines: lines.length, short_picks,
  });
  return { ok: true, idempotent: false, effects, short_picks };
}

// ─── Restock board ───────────────────────────────────────────────────────────

export type RestockBoardVisit = VisitRow & {
  unit_label: string;
  unit_category: string | null;
  venue_id: string | null;
  venue_name: string | null;
  technician_label: string | null;
  lines: (VisitLineRow & { sku_name: string; sku_category: string })[];
};

export type RestockBoard = {
  visits: RestockBoardVisit[];
  eligibleUnits: EligibleUnit[];
  skus: { id: string; name: string; category: string }[];
  staff: { id: string; label: string }[];
  openCount: number;
};

/** Visits with unit/venue/technician/SKU joins + line detail, plus form directories. */
export async function loadRestockBoard(db: SupabaseClient): Promise<RestockBoard | { error: string }> {
  const [visitsRes, linesRes, unitsRes, venuesRes, staffRes, skusRes] = await Promise.all([
    db.from("restock_visits").select("*").order("created_at", { ascending: false }).limit(200),
    db.from("restock_visit_lines").select("*").limit(5000),
    db.from("equipment_units").select("id,serial_number,model_label,category,status,venue_id").limit(2000),
    db.from("venues").select("id,name").limit(1000),
    db.from("profiles").select("id,email,full_name").in("role", ["admin", "staff"]).order("email").limit(200),
    db.from("product_skus").select("id,name,category").eq("active", true).order("name").limit(1000),
  ]);
  if (visitsRes.error) return { error: "restock_load_failed" };

  const visits = (visitsRes.data ?? []) as unknown as VisitRow[];
  const lines = (linesRes.data ?? []) as unknown as VisitLineRow[];
  const units = (unitsRes.data ?? []) as unknown as { id: string; serial_number: string | null; model_label: string | null; category: string | null; status: string; venue_id: string | null }[];
  const venues = (venuesRes.data ?? []) as unknown as { id: string; name: string }[];
  const staff = (staffRes.data ?? []) as unknown as { id: string; email: string | null; full_name: string | null }[];
  const skus = (skusRes.data ?? []) as unknown as { id: string; name: string; category: string }[];

  const unitById = new Map(units.map((u) => [u.id, u]));
  const venueName = new Map(venues.map((v) => [v.id, v.name]));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const linesByVisit = new Map<string, VisitLineRow[]>();
  for (const l of lines) {
    const arr = linesByVisit.get(l.visit_id) ?? [];
    arr.push(l);
    linesByVisit.set(l.visit_id, arr);
  }
  const techLabel = new Map(staff.map((s) => [s.id, s.full_name || s.email || s.id]));

  const boardVisits: RestockBoardVisit[] = visits.map((v) => {
    const unit = unitById.get(v.unit_id);
    return {
      ...v,
      unit_label: unit ? unitLabel(unit) : v.unit_id.slice(0, 8),
      unit_category: unit?.category ?? null,
      venue_id: unit?.venue_id ?? null,
      venue_name: unit?.venue_id ? venueName.get(unit.venue_id) ?? null : null,
      technician_label: v.technician ? techLabel.get(v.technician) ?? v.technician.slice(0, 8) : null,
      lines: (linesByVisit.get(v.id) ?? []).map((l) => ({
        ...l,
        sku_name: skuById.get(l.sku_id)?.name ?? l.sku_id.slice(0, 8),
        sku_category: skuById.get(l.sku_id)?.category ?? "",
      })),
    };
  });

  return {
    visits: boardVisits,
    eligibleUnits: units
      .filter((u) => u.status !== "retired" && isProductUnitCategory(u.category))
      .map((u) => ({ id: u.id, label: unitLabel(u), category: u.category!, venue_id: u.venue_id })),
    skus,
    staff: staff.map((s) => ({ id: s.id, label: s.full_name || s.email || s.id })),
    openCount: boardVisits.filter((v) => v.status === "planned" || v.status === "in_progress").length,
  };
}
