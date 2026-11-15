import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adjustStock, setStockCount, createSku, updateSku, toggleActiveSku,
  loadInventoryBoard, createVisit, upsertVisitLine, transitionVisit, completeVisit,
  loadRestockBoard, validateLocation,
} from "@/lib/inventory";

/**
 * Phase 7 inventory/restock tests. In-memory Supabase stub that actually
 * applies insert/update so stock math can be verified end-to-end.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: Row | Row[] | null = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: Row | Row[]) { this.op = "insert"; this.payload = p; return this; }
    update(p: Row) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      if (this.op === "insert") {
        const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const inserted = incoming.map((r) => ({ id: crypto.randomUUID(), ...r }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (this.op === "update") {
        const matched = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const r of matched) Object.assign(r, this.payload as Row);
        return { data: matched, error: null };
      }
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    private first() {
      const { data } = this.run();
      const arr = Array.isArray(data) ? data : data ? [data as Row] : [];
      return { data: arr[0] ?? null, error: null };
    }
    single() { return this.first(); }
    maybeSingle() { return this.first(); }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const skuId = () => crypto.randomUUID();
const unitId = () => crypto.randomUUID();
const venueId = () => crypto.randomUUID();
const visitId = () => crypto.randomUUID();

const sku = (over: Row = {}): Row => ({
  id: skuId(), category: "snack", name: "Chips", supplier: "Acme",
  unit_cost_cents: 150, reorder_point: 5, track_expiry: false, active: true, notes: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});
const unit = (over: Row = {}): Row => ({
  id: unitId(), category: "snack", status: "active", serial_number: "SN-1",
  model_label: "VendPro 3000", venue_id: null, ...over,
});
const level = (over: Row = {}): Row => ({
  id: crypto.randomUUID(), sku_id: skuId(), unit_id: null, venue_id: null, qty: 0,
  updated_at: "2026-01-01T00:00:00Z", ...over,
});
const visit = (over: Row = {}): Row => ({
  id: visitId(), unit_id: unitId(), technician: null, status: "planned",
  scheduled_for: null, notes: null, created_by: null, created_at: "2026-01-01T00:00:00Z",
  completed_at: null, ...over,
});
const line = (over: Row = {}): Row => ({
  id: crypto.randomUUID(), visit_id: visitId(), sku_id: skuId(),
  qty_picked: 0, qty_loaded: 0, qty_waste: 0, created_at: "2026-01-01T00:00:00Z", ...over,
});

// ─── adjustStock / setStockCount ─────────────────────────────────────────────

describe("adjustStock", () => {
  it("creates a warehouse row on positive delta", async () => {
    const s = sku();
    const { db, tables } = fakeDb({ product_skus: [s] });
    const res = await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.before).toBe(0); expect(res.after).toBe(10); }
    expect(tables.stock_levels).toHaveLength(1);
    expect(tables.stock_levels[0].unit_id).toBeNull();
    expect(tables.stock_levels[0].venue_id).toBeNull();
  });

  it("accumulates deltas on the same location", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: 10 });
    const res = await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: -4 });
    expect(res.ok && res.after).toBe(6);
  });

  it("rejects a negative result and leaves qty unchanged", async () => {
    const s = sku();
    const { db, tables } = fakeDb({ product_skus: [s], stock_levels: [level({ sku_id: s.id, qty: 5 })] });
    const res = await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: -6 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("insufficient_stock");
    expect(tables.stock_levels[0].qty).toBe(5);
  });

  it("rejects negative delta when no row exists", async () => {
    const s = sku();
    const { db, tables } = fakeDb({ product_skus: [s] });
    const res = await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: -1 });
    expect(res.ok).toBe(false);
    expect(tables.stock_levels ?? []).toHaveLength(0);
  });

  it("rejects zero and non-integer deltas", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    expect((await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: 0 })).ok).toBe(false);
    expect((await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: 1.5 })).ok).toBe(false);
  });

  it("rejects both unit_id and venue_id set", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    const res = await adjustStock(db, ACTOR, { sku_id: s.id as string, unit_id: unitId(), venue_id: venueId(), delta: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("both");
  });

  it("keeps warehouse / unit / venue stock as separate rows (cross-location uniqueness)", async () => {
    const s = sku(); const u = unitId(); const v = venueId();
    const { db, tables } = fakeDb({ product_skus: [s] });
    await adjustStock(db, ACTOR, { sku_id: s.id as string, delta: 10 });
    await adjustStock(db, ACTOR, { sku_id: s.id as string, unit_id: u, delta: 3 });
    await adjustStock(db, ACTOR, { sku_id: s.id as string, venue_id: v, delta: 2 });
    await adjustStock(db, ACTOR, { sku_id: s.id as string, unit_id: u, delta: 1 });
    expect(tables.stock_levels).toHaveLength(3);
    const unitRow = tables.stock_levels.find((r) => r.unit_id === u)!;
    expect(unitRow.qty).toBe(4);
  });
});

describe("setStockCount", () => {
  it("sets absolute qty and reports before/after", async () => {
    const s = sku();
    const { db, tables } = fakeDb({ product_skus: [s], stock_levels: [level({ sku_id: s.id, qty: 7 })] });
    const res = await setStockCount(db, ACTOR, { sku_id: s.id as string, qty: 3 });
    expect(res.ok && res.before === 7 && res.after === 3).toBe(true);
    expect(tables.stock_levels[0].qty).toBe(3);
  });

  it("creates a row when none exists", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    const res = await setStockCount(db, ACTOR, { sku_id: s.id as string, qty: 12 });
    expect(res.ok && res.after === 12).toBe(true);
  });

  it("rejects negative counts", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    expect((await setStockCount(db, ACTOR, { sku_id: s.id as string, qty: -1 })).ok).toBe(false);
  });
});

// ─── SKU CRUD + board ────────────────────────────────────────────────────────

describe("SKU CRUD", () => {
  it("createSku validates category and inserts", async () => {
    const { db } = fakeDb();
    expect((await createSku(db, ACTOR, { category: "bogus" as never, name: "X" })).ok).toBe(false);
    const res = await createSku(db, ACTOR, { category: "beverage", name: "Cola", unit_cost_cents: 99, reorder_point: 4 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sku.name).toBe("Cola");
  });

  it("updateSku applies partial patches and rejects empty patches", async () => {
    const s = sku();
    const { db } = fakeDb({ product_skus: [s] });
    const res = await updateSku(db, ACTOR, s.id as string, { reorder_point: 9, notes: "fragile" });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.sku.reorder_point).toBe(9); expect(res.sku.name).toBe("Chips"); }
    expect((await updateSku(db, ACTOR, s.id as string, {})).ok).toBe(false);
  });

  it("toggleActiveSku flips the flag", async () => {
    const s = sku({ active: true });
    const { db } = fakeDb({ product_skus: [s] });
    const res = await toggleActiveSku(db, ACTOR, s.id as string);
    expect(res.ok && res.sku.active === false).toBe(true);
  });
});

describe("loadInventoryBoard", () => {
  it("aggregates stock per location and flags low stock", async () => {
    const s1 = sku({ name: "A", reorder_point: 5 });
    const s2 = sku({ name: "B", reorder_point: 3 });
    const u = unit({ category: "snack", status: "active" });
    const { db } = fakeDb({
      product_skus: [s1, s2],
      equipment_units: [u],
      venues: [{ id: venueId(), name: "Tavern" }],
      stock_levels: [
        level({ sku_id: s1.id, qty: 5 }),                                  // warehouse, at reorder → low
        level({ sku_id: s1.id, unit_id: u.id, qty: 2 }),                    // inside machine
        level({ sku_id: s2.id, qty: 10 }),                                  // healthy
      ],
    });
    const board = await loadInventoryBoard(db);
    expect("error" in board).toBe(false);
    if ("error" in board) return;
    const a = board.skus.find((x) => x.id === s1.id)!;
    const b = board.skus.find((x) => x.id === s2.id)!;
    expect(a.warehouse).toBe(5);
    expect(a.total).toBe(7);
    expect(a.lowStock).toBe(true);
    expect(a.locations.find((l) => l.kind === "unit")!.low).toBe(true);   // 2 <= 5
    expect(b.lowStock).toBe(false);
    expect(board.lowStockCount).toBe(1);
    // implicit zero warehouse row surfaced for SKUs without one
    const bWh = b.locations.find((l) => l.kind === "warehouse")!;
    expect(bWh.qty).toBe(10);
  });

  it("surfaces a zero warehouse row for SKUs with no stock", async () => {
    const s = sku({ reorder_point: 0 });
    const { db } = fakeDb({ product_skus: [s] });
    const board = await loadInventoryBoard(db);
    if ("error" in board) throw new Error("board failed");
    const row = board.skus[0];
    expect(row.locations.some((l) => l.kind === "warehouse" && l.qty === 0)).toBe(true);
  });
});

// ─── Restock visits ──────────────────────────────────────────────────────────

describe("createVisit", () => {
  it("rejects retired and non-product units", async () => {
    const retired = unit({ status: "retired" });
    const charger = unit({ category: "charger_station" });
    const { db } = fakeDb({ equipment_units: [retired, charger] });
    expect((await createVisit(db, ACTOR, { unit_id: retired.id as string })).ok).toBe(false);
    const res = await createVisit(db, ACTOR, { unit_id: charger.id as string });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unit_cannot_hold_stock");
  });

  it("creates a planned visit for a product unit", async () => {
    const u = unit({ category: "beverage" });
    const { db } = fakeDb({ equipment_units: [u] });
    const res = await createVisit(db, ACTOR, { unit_id: u.id as string, scheduled_for: "2026-03-01T10:00" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.visit.status).toBe("planned");
  });
});

describe("visit lines", () => {
  it("upserts on (visit_id, sku_id) and edits only open visits", async () => {
    const u = unit(); const s = sku(); const v = visit({ unit_id: u.id, status: "in_progress" });
    const { db, tables } = fakeDb({ equipment_units: [u], product_skus: [s], restock_visits: [v] });
    await upsertVisitLine(db, ACTOR, { visit_id: v.id as string, sku_id: s.id as string, qty_picked: 4, qty_loaded: 3, qty_waste: 1 });
    await upsertVisitLine(db, ACTOR, { visit_id: v.id as string, sku_id: s.id as string, qty_picked: 6, qty_loaded: 5, qty_waste: 1 });
    expect(tables.restock_visit_lines).toHaveLength(1);
    expect(tables.restock_visit_lines[0].qty_picked).toBe(6);
  });

  it("rejects line edits on completed/cancelled visits", async () => {
    const s = sku();
    const done = visit({ status: "completed" });
    const { db } = fakeDb({ product_skus: [s], restock_visits: [done] });
    const res = await upsertVisitLine(db, ACTOR, { visit_id: done.id as string, sku_id: s.id as string, qty_picked: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("visit_closed");
  });
});

describe("visit lifecycle", () => {
  it("planned → in_progress → completed; invalid transitions rejected", async () => {
    const v = visit({ status: "planned" });
    const { db } = fakeDb({ restock_visits: [v] });
    const started = await transitionVisit(db, ACTOR, v.id as string, "in_progress");
    expect(started.ok && (started as { visit: { status: string } }).visit.status).toBe("in_progress");
    const again = await transitionVisit(db, ACTOR, v.id as string, "planned");
    expect(again.ok).toBe(false);
  });

  it("planned → cancelled allowed; cancelled is terminal", async () => {
    const v = visit({ status: "planned" });
    const { db } = fakeDb({ restock_visits: [v] });
    const res = await transitionVisit(db, ACTOR, v.id as string, "cancelled");
    expect(res.ok).toBe(true);
    expect((await transitionVisit(db, ACTOR, v.id as string, "in_progress")).ok).toBe(false);
  });
});

describe("completeVisit stock effects", () => {
  function seedVisit(status = "in_progress") {
    const s = sku(); const u = unit({ venue_id: venueId() }); const v = visit({ unit_id: u.id, status });
    const { db, tables } = fakeDb({
      product_skus: [s], equipment_units: [u], restock_visits: [v],
      stock_levels: [level({ sku_id: s.id, qty: 10 })],
      restock_visit_lines: [line({ visit_id: v.id, sku_id: s.id, qty_picked: 4, qty_loaded: 3, qty_waste: 1 })],
    });
    return { db, tables, s, u, v };
  }

  it("decrements warehouse by picked, increments unit by loaded, records waste", async () => {
    const { db, tables, s, u, v } = seedVisit();
    const res = await completeVisit(db, ACTOR, v.id as string);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.idempotent).toBe(false);
    expect(res.effects).toHaveLength(1);
    const wh = tables.stock_levels.find((r) => r.sku_id === s.id && r.unit_id == null && r.venue_id == null)!;
    const un = tables.stock_levels.find((r) => r.sku_id === s.id && r.unit_id === u.id)!;
    expect(wh.qty).toBe(6);   // 10 - 4 picked
    expect(un.qty).toBe(3);   // 0 + 3 loaded
    expect(res.effects[0].qty_waste).toBe(1);
    expect(res.effects[0].short_pick).toBe(false);
    expect(tables.restock_visits[0].status).toBe("completed");
    expect(tables.restock_visits[0].completed_at).toBeTruthy();
  });

  it("clamps warehouse at 0 and flags short_pick", async () => {
    const s = sku(); const u = unit(); const v = visit({ unit_id: u.id, status: "in_progress" });
    const { db, tables } = fakeDb({
      product_skus: [s], equipment_units: [u], restock_visits: [v],
      stock_levels: [level({ sku_id: s.id, qty: 2 })],
      restock_visit_lines: [line({ visit_id: v.id, sku_id: s.id, qty_picked: 5, qty_loaded: 4 })],
    });
    const res = await completeVisit(db, ACTOR, v.id as string);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.short_picks).toEqual([s.id]);
    const wh = tables.stock_levels.find((r) => r.unit_id == null)!;
    expect(wh.qty).toBe(0);
  });

  it("is idempotent — re-completing does not re-apply stock", async () => {
    const { db, tables, v } = seedVisit();
    await completeVisit(db, ACTOR, v.id as string);
    const qtyAfterFirst = tables.stock_levels.map((r) => r.qty);
    const res = await completeVisit(db, ACTOR, v.id as string);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.idempotent).toBe(true);
    expect(tables.stock_levels.map((r) => r.qty)).toEqual(qtyAfterFirst);
  });

  it("refuses to complete a cancelled visit", async () => {
    const v = visit({ status: "cancelled" });
    const { db } = fakeDb({ restock_visits: [v] });
    const res = await completeVisit(db, ACTOR, v.id as string);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("visit_cancelled");
  });

  it("completes with zero lines and sets completed_at", async () => {
    const u = unit(); const v = visit({ unit_id: u.id, status: "planned" });
    const { db, tables } = fakeDb({ equipment_units: [u], restock_visits: [v] });
    const res = await completeVisit(db, ACTOR, v.id as string);
    expect(res.ok && res.effects.length === 0).toBe(true);
    expect(tables.restock_visits[0].status).toBe("completed");
  });
});

describe("loadRestockBoard", () => {
  it("joins unit, venue, technician and line detail", async () => {
    const u = unit({ venue_id: venueId(), serial_number: "SN-9" });
    const v = visit({ unit_id: u.id, technician: ACTOR, status: "in_progress" });
    const s = sku();
    const { db } = fakeDb({
      equipment_units: [u], restock_visits: [v], product_skus: [s],
      restock_visit_lines: [line({ visit_id: v.id, sku_id: s.id, qty_picked: 2, qty_loaded: 2 })],
      venues: [{ id: u.venue_id, name: "Tavern" }],
      profiles: [{ id: ACTOR, email: "tech@x.com", full_name: "Tech One", role: "staff" }],
    });
    const board = await loadRestockBoard(db);
    expect("error" in board).toBe(false);
    if ("error" in board) return;
    const row = board.visits.find((x) => x.id === v.id)!;
    expect(row.unit_label).toContain("SN-9");
    expect(row.venue_name).toBe("Tavern");
    expect(row.technician_label).toBe("Tech One");
    expect(row.lines[0].sku_name).toBe("Chips");
    expect(board.openCount).toBe(1);
    expect(board.skus.map((x) => x.id)).toContain(s.id);
  });
});

describe("validateLocation", () => {
  it("normalizes nulls and rejects dual location", () => {
    expect(validateLocation(null, null).ok).toBe(true);
    expect(validateLocation(undefined, undefined).ok).toBe(true);
    expect(validateLocation(unitId(), null).ok).toBe(true);
    expect(validateLocation(null, venueId()).ok).toBe(true);
    expect(validateLocation(unitId(), venueId()).ok).toBe(false);
    expect(validateLocation("not-a-uuid", null).ok).toBe(false);
  });
});
