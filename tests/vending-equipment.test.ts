import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_LIFECYCLE, EQUIPMENT_MODEL_CATEGORIES, EQUIPMENT_TRANSITIONS,
  UNIT_OWNERSHIP, canTransition, createModel, createUnit, isEquipmentStatus,
  isModelCategory, loadEquipmentBoard, nextStatuses, transitionPatch, transitionUnit,
  updateModel, updateUnit, type EquipmentStatus,
} from "../src/lib/vending-equipment";

/* ─── Lifecycle legality ─────────────────────────────────────────────────── */

describe("equipment lifecycle transitions", () => {
  it("walks the full forward spine legally", () => {
    const spine: EquipmentStatus[] = ["planned", "sourcing", "ordered", "received", "inspected", "available", "assigned", "installed", "active"];
    for (let i = 0; i < spine.length - 1; i++) {
      expect(canTransition(spine[i], spine[i + 1])).toBe(true);
    }
    expect(canTransition("active", "maintenance")).toBe(true);
    expect(canTransition("maintenance", "active")).toBe(true);
  });

  it("allows documented backward corrections but not arbitrary jumps", () => {
    expect(canTransition("sourcing", "planned")).toBe(true);
    expect(canTransition("ordered", "sourcing")).toBe(true);
    expect(canTransition("received", "ordered")).toBe(true);
    expect(canTransition("inspected", "received")).toBe(true);
    expect(canTransition("assigned", "available")).toBe(true);
    expect(canTransition("maintenance", "installed")).toBe(true);
    // skips are not allowed
    expect(canTransition("planned", "ordered")).toBe(false);
    expect(canTransition("received", "planned")).toBe(false);
    expect(canTransition("available", "installed")).toBe(false);
    expect(canTransition("active", "installed")).toBe(false);
  });

  it("every non-terminal status can retire; retired is terminal", () => {
    for (const s of EQUIPMENT_LIFECYCLE.filter((x) => x !== "retired")) {
      expect(canTransition(s, "retired")).toBe(true);
    }
    expect(canTransition("retired", "planned")).toBe(false);
    expect(canTransition("retired", "active")).toBe(false);
    expect(nextStatuses("retired")).toEqual([]);
    // every declared next status is itself a real status
    for (const [from, tos] of Object.entries(EQUIPMENT_TRANSITIONS)) {
      for (const to of tos) expect(isEquipmentStatus(to)).toBe(true);
      expect(isEquipmentStatus(from)).toBe(true);
    }
  });

  it("rejects self-transitions and unknown statuses", () => {
    expect(canTransition("active", "active")).toBe(false);
    expect(canTransition("planned", "active" as EquipmentStatus)).toBe(false);
  });
});

describe("transitionPatch", () => {
  const now = new Date("2026-03-01T12:00:00Z");

  it("sets installed_at only when entering installed", () => {
    const r = transitionPatch("assigned", "installed", now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ status: "installed", installed_at: "2026-03-01T12:00:00.000Z" });
    const a = transitionPatch("installed", "active", now);
    expect(a.ok && !("installed_at" in a.patch)).toBe(true);
  });

  it("sets retired_at only when entering retired", () => {
    const r = transitionPatch("active", "retired", now);
    expect(r.ok && r.patch.retired_at === "2026-03-01T12:00:00.000Z").toBe(true);
    const m = transitionPatch("installed", "maintenance", now);
    expect(m.ok && !("retired_at" in m.patch) && !("installed_at" in m.patch)).toBe(true);
  });

  it("never unsets timestamps on reverse moves (first install stands)", () => {
    const r = transitionPatch("maintenance", "active", now);
    expect(r.ok && Object.keys(r.patch)).toEqual(["status"]);
  });

  it("rejects illegal moves with a readable error", () => {
    const r = transitionPatch("planned", "active", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot move");
  });
});

describe("category / status guards", () => {
  it("accepts all seven model categories incl. combo", () => {
    expect(EQUIPMENT_MODEL_CATEGORIES).toHaveLength(7);
    for (const c of EQUIPMENT_MODEL_CATEGORIES) expect(isModelCategory(c)).toBe(true);
    expect(isModelCategory("gumball")).toBe(false);
    expect(UNIT_OWNERSHIP).toContain("leased");
  });
});

/* ─── Recording Supabase mock ────────────────────────────────────────────── */

type Call = { table: string; method: string; args: unknown[] };
type DbError = { code?: string; message?: string } | null;

/**
 * Chainable mock: select→maybeSingle/single serve `singles[table]` (or the
 * update patch merged over it); update→select→maybeSingle returns null when the
 * table is in `updateMiss` (simulates the optimistic status guard losing a race).
 * insert→select→single serves `insertResult` or `insertErrors[table]`.
 * limit() resolves list fixtures; `errors[table]` injects a query error.
 */
function mockDb(
  fixtures: Record<string, unknown[]> = {},
  opts: {
    singles?: Record<string, unknown>;
    insertErrors?: Record<string, DbError>;
    insertResult?: Record<string, unknown>;
    updateMiss?: string[];
    errors?: Record<string, DbError>;
  } = {},
) {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      let inserting = false;
      const builder = {
        select: () => builder,
        eq: (...args: unknown[]) => { calls.push({ table, method: "eq", args }); return builder; },
        in: (...args: unknown[]) => { calls.push({ table, method: "in", args }); return builder; },
        order: () => builder,
        limit: () => Promise.resolve({ data: fixtures[table] ?? [], error: opts.errors?.[table] ?? null }),
        insert: (row: unknown) => { inserting = true; calls.push({ table, method: "insert", args: [row] }); return builder; },
        update: (p: Record<string, unknown>) => { patch = p; calls.push({ table, method: "update", args: [p] }); return builder; },
        maybeSingle: () => {
          if (inserting) {
            const err = opts.insertErrors?.[table];
            return Promise.resolve({ data: err ? null : (opts.insertResult?.[table] ?? { id: "new-id" }), error: err ?? null });
          }
          if (patch) {
            if ((opts.updateMiss ?? []).includes(table)) return Promise.resolve({ data: null, error: null });
            const base = opts.singles?.[table];
            // No matching row → update().select() yields nothing (like PostgREST).
            if (base === null || base === undefined) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { ...(base as Record<string, unknown>), ...patch }, error: null });
          }
          return Promise.resolve({ data: opts.singles?.[table] ?? null, error: null });
        },
        single: () => {
          if (inserting) {
            const err = opts.insertErrors?.[table];
            return Promise.resolve({ data: err ? null : (opts.insertResult?.[table] ?? { id: "new-id" }), error: err ?? null });
          }
          return Promise.resolve({ data: opts.singles?.[table] ?? null, error: null });
        },
        // Supabase builders are thenable — a bare `await insert(...)` resolves here.
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: opts.insertErrors?.[table] ?? null }).then(resolve, reject),
      };
      return builder;
    },
  };
  return db;
}

const U = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

/* ─── transitionUnit ─────────────────────────────────────────────────────── */

describe("transitionUnit", () => {
  it("404s on a missing unit", async () => {
    const db = mockDb({}, { singles: { equipment_units: null } });
    const r = await transitionUnit(db as never, ACTOR, U, "sourcing");
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("409s on an illegal move and writes nothing", async () => {
    const db = mockDb({}, { singles: { equipment_units: { id: U, status: "planned" } } });
    const r = await transitionUnit(db as never, ACTOR, U, "active");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.calls.filter((c) => c.method === "update")).toHaveLength(0);
    expect(db.calls.filter((c) => c.method === "insert")).toHaveLength(0);
  });

  it("updates under an optimistic status guard and appends a lifecycle event", async () => {
    const db = mockDb({}, { singles: { equipment_units: { id: U, status: "planned" } } });
    const now = new Date("2026-04-01T00:00:00Z");
    const r = await transitionUnit(db as never, ACTOR, U, "sourcing", "PO sent", now);
    expect(r).toEqual({ ok: true, before: "planned", after: "sourcing" });
    const eqs = db.calls.filter((c) => c.table === "equipment_units" && c.method === "eq");
    expect(eqs.some((c) => c.args[0] === "status" && c.args[1] === "planned")).toBe(true);
    const ev = db.calls.find((c) => c.table === "equipment_lifecycle_events" && c.method === "insert");
    expect(ev).toBeTruthy();
    expect(ev!.args[0]).toMatchObject({ unit_id: U, from_status: "planned", to_status: "sourcing", actor: ACTOR, note: "PO sent" });
  });

  it("stamps installed_at when transitioning into installed", async () => {
    const db = mockDb({}, { singles: { equipment_units: { id: U, status: "assigned" } } });
    const now = new Date("2026-04-02T00:00:00Z");
    const r = await transitionUnit(db as never, ACTOR, U, "installed", null, now);
    expect(r.ok).toBe(true);
    const upd = db.calls.find((c) => c.method === "update");
    expect((upd!.args[0] as Record<string, unknown>).installed_at).toBe("2026-04-02T00:00:00.000Z");
  });

  it("409s when the unit changed underneath (guard loses the race)", async () => {
    const db = mockDb({}, { singles: { equipment_units: { id: U, status: "planned" } }, updateMiss: ["equipment_units"] });
    const r = await transitionUnit(db as never, ACTOR, U, "sourcing");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.calls.filter((c) => c.table === "equipment_lifecycle_events")).toHaveLength(0);
  });

  it("surfaces an error when the lifecycle event cannot be recorded", async () => {
    const db = mockDb({}, {
      singles: { equipment_units: { id: U, status: "planned" } },
      insertErrors: { equipment_lifecycle_events: { message: "rls" } },
    });
    const r = await transitionUnit(db as never, ACTOR, U, "sourcing");
    expect(r).toMatchObject({ ok: false, status: 500 });
  });
});

/* ─── createUnit / updateUnit ────────────────────────────────────────────── */

describe("createUnit", () => {
  const base = { category: "snack", serial_number: "SN-1" };

  it("creates a planned unit with actor attribution", async () => {
    const db = mockDb();
    const r = await createUnit(db as never, ACTOR, base);
    expect(r).toEqual({ ok: true, id: "new-id" });
    const ins = db.calls.find((c) => c.method === "insert")!;
    expect(ins.args[0]).toMatchObject({ category: "snack", status: "planned", created_by: ACTOR });
  });

  it("maps a unique-serial conflict to a friendly 409", async () => {
    const db = mockDb({}, { insertErrors: { equipment_units: { code: "23505", message: "duplicate key value violates unique constraint" } } });
    const r = await createUnit(db as never, ACTOR, base);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (!r.ok) expect(r.error).toMatch(/serial/i);
  });

  it("rejects kiosk links on non-charger categories", async () => {
    const db = mockDb();
    const r = await createUnit(db as never, ACTOR, { ...base, category: "beverage", kiosk_id: U });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(db.calls.filter((c) => c.method === "insert")).toHaveLength(0);
  });

  it("rejects negative costs and bad categories", async () => {
    const db = mockDb();
    expect((await createUnit(db as never, ACTOR, { ...base, cost_cents: -5 })).ok).toBe(false);
    expect((await createUnit(db as never, ACTOR, { ...base, category: "gumball" })).ok).toBe(false);
  });
});

describe("updateUnit", () => {
  it("404s on a missing unit", async () => {
    const db = mockDb({}, { singles: { equipment_units: null } });
    const r = await updateUnit(db as never, U, { venue_id: null });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("patches only provided keys — a venue assign can't wipe other fields", async () => {
    const existing = {
      id: U, category: "snack", serial_number: "SN-9", ownership: "company",
      cost_cents: 12000, kiosk_id: null, venue_id: null, model_id: null,
      manufacturer: null, model_label: null, service_schedule: null, notes: null,
    };
    const db = mockDb({}, { singles: { equipment_units: existing } });
    const venue = "33333333-3333-4333-8333-333333333333";
    const r = await updateUnit(db as never, U, { venue_id: venue });
    expect(r.ok).toBe(true);
    const upd = db.calls.find((c) => c.method === "update")!;
    const patch = upd.args[0] as Record<string, unknown>;
    expect(patch).toEqual({ venue_id: venue });
  });

  it("re-validates the merged row (charger-only kiosk rule still applies)", async () => {
    const existing = { id: U, category: "beverage", kiosk_id: null, serial_number: null, venue_id: null, ownership: "company", cost_cents: null, model_id: null, manufacturer: null, model_label: null, service_schedule: null, notes: null };
    const db = mockDb({}, { singles: { equipment_units: existing } });
    const r = await updateUnit(db as never, U, { kiosk_id: U });
    expect(r).toMatchObject({ ok: false, status: 422 });
  });
});

/* ─── createModel / updateModel ──────────────────────────────────────────── */

describe("model helpers", () => {
  it("createModel validates category and required name", async () => {
    const db = mockDb();
    expect((await createModel(db as never, ACTOR, { category: "nope", model_name: "X" })).ok).toBe(false);
    expect((await createModel(db as never, ACTOR, { category: "combo", model_name: "  " })).ok).toBe(false);
    const r = await createModel(db as never, ACTOR, { category: "combo", model_name: "VM-1", acquisition_cost_cents: 500000 });
    expect(r).toEqual({ ok: true, id: "new-id" });
    const ins = db.calls.find((c) => c.table === "equipment_models" && c.method === "insert")!;
    expect(ins.args[0]).toMatchObject({ category: "combo", status: "draft", created_by: ACTOR });
  });

  it("updateModel 404s when the row is gone", async () => {
    const db = mockDb({}, { singles: { equipment_models: null } });
    const r = await updateModel(db as never, U, { category: "snack", model_name: "X" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

/* ─── loadEquipmentBoard ────────────────────────────────────────────────── */

describe("loadEquipmentBoard", () => {
  const fixtures = {
    equipment_models: [
      { id: "m1", category: "snack", model_name: "VM-400", manufacturer: "Acme", status: "active" },
      { id: "m2", category: "charger_station", model_name: "CP-1", manufacturer: null, status: "draft" },
    ],
    equipment_units: [
      {
        id: "u1", serial_number: "SN-1", category: "snack", status: "active", ownership: "company",
        venue_id: "v1", kiosk_id: null, model_id: "m1", cost_cents: 1000,
        equipment_models: { model_name: "VM-400", manufacturer: "Acme", category: "snack" },
        venues: { name: "Tavern" }, kiosks: null,
      },
      {
        id: "u2", serial_number: "CP-9", category: "charger_station", status: "maintenance", ownership: "company",
        venue_id: "v1", kiosk_id: "k1", model_id: "m2", cost_cents: null,
        equipment_models: [{ model_name: "CP-1", manufacturer: null, category: "charger_station" }],
        venues: [{ name: "Tavern" }], kiosks: { station_id: "ZN-ABC" },
      },
      {
        id: "u3", serial_number: null, category: "snack", status: "planned", ownership: "leased",
        venue_id: null, kiosk_id: null, model_id: null, cost_cents: null,
        equipment_models: null, venues: null, kiosks: null,
      },
    ],
    venues: [{ id: "v1", name: "Tavern", city: "Minneapolis" }],
    kiosks: [{ id: "k1", station_id: "ZN-ABC" }],
  };

  it("aggregates counts and resolves model/venue/kiosk joins", async () => {
    const db = mockDb(fixtures);
    const b = await loadEquipmentBoard(db as never);
    expect(b.unavailable).toBe(false);
    expect(b.models).toHaveLength(2);
    expect(b.units).toHaveLength(3);
    expect(b.counts.total).toBe(3);
    expect(b.counts.byStatus).toMatchObject({ active: 1, maintenance: 1, planned: 1 });
    expect(b.counts.byCategory).toMatchObject({ snack: 2, charger_station: 1 });
    // single-object and array-wrapped embeds both resolve
    expect(b.units[0].venue?.name).toBe("Tavern");
    expect(b.units[0].model?.model_name).toBe("VM-400");
    expect(b.units[1].kiosk?.station_id).toBe("ZN-ABC");
    expect(b.units[2].venue).toBeNull();
    expect(b.venues[0].name).toBe("Tavern");
    expect(b.kiosks[0].station_id).toBe("ZN-ABC");
  });

  it("returns an honest unavailable board when a query fails", async () => {
    const db = mockDb(fixtures, { errors: { equipment_units: { message: "boom" } } });
    const b = await loadEquipmentBoard(db as never);
    expect(b.unavailable).toBe(true);
    expect(b.units).toEqual([]);
    expect(b.counts.total).toBe(0);
  });

  it("returns unavailable when the client throws", async () => {
    const db = { from: () => { throw new Error("no db"); } };
    const b = await loadEquipmentBoard(db as never);
    expect(b.unavailable).toBe(true);
  });
});
