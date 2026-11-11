import { describe, expect, it } from "vitest";
import {
  assignVariant, canTransition, hashSubject, isActive, isForbiddenAudience,
  type ExperimentStatus,
} from "@/lib/experiments/core";
import {
  assign, createExperiment, getExperiment, recordConversion, recordExposure, results, subjectHashText, transition,
} from "@/lib/experiments/service";

/* ── core ─────────────────────────────────────────────────────────────── */

describe("hashSubject", () => {
  it("is deterministic and returns a stable 32-bit int", () => {
    const h = hashSubject("visitor-1:hero_cta");
    expect(h).toBe(hashSubject("visitor-1:hero_cta"));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(hashSubject("visitor-1:hero_cta")).not.toBe(hashSubject("visitor-1:other_exp")); // per-experiment salt differs
  });
});

describe("assignVariant", () => {
  const variants = [{ key: "control", weight: 70 }, { key: "b", weight: 30 }];
  it("is deterministic for the same hash", () => {
    expect(assignVariant(variants, 12345)).toBe(assignVariant(variants, 12345));
  });
  it("always returns a defined variant key for usable weights", () => {
    for (let h = 0; h < 500; h++) expect(["control", "b"]).toContain(assignVariant(variants, h));
    expect(assignVariant([], 1)).toBeNull();
    expect(assignVariant([{ key: "x", weight: 0 }], 1)).toBeNull();
  });
  it("distributes roughly according to weights over 1000 hashes", () => {
    let b = 0;
    for (let h = 0; h < 1000; h++) if (assignVariant(variants, h) === "b") b++;
    expect(b).toBeGreaterThan(200);
    expect(b).toBeLessThan(400);
  });
  it("single variant always wins", () => {
    expect(assignVariant([{ key: "only", weight: 1 }], 999)).toBe("only");
  });
});

describe("isActive", () => {
  const base = { status: "running" as ExperimentStatus, start_at: null, end_at: null };
  const now = Date.parse("2025-06-15T12:00:00Z");
  it("running with no window is always active", () => {
    expect(isActive(base, now)).toBe(true);
  });
  it("respects start/end window inclusively", () => {
    expect(isActive({ ...base, start_at: "2025-06-15T12:00:00Z" }, now)).toBe(true);
    expect(isActive({ ...base, start_at: "2025-06-15T12:00:01Z" }, now)).toBe(false);
    expect(isActive({ ...base, end_at: "2025-06-15T12:00:00Z" }, now)).toBe(true);
    expect(isActive({ ...base, end_at: "2025-06-15T11:59:59Z" }, now)).toBe(false);
  });
  it("non-running statuses are never active", () => {
    for (const s of ["draft", "approved", "paused", "concluded"] as ExperimentStatus[]) {
      expect(isActive({ ...base, status: s }, now)).toBe(false);
    }
  });
});

describe("transition state machine", () => {
  it("blocks draft→running and allows the approved path", () => {
    expect(canTransition("draft", "running")).toBe(false);
    expect(canTransition("draft", "approved")).toBe(true);
    expect(canTransition("approved", "running")).toBe(true);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "concluded")).toBe(true);
    expect(canTransition("paused", "concluded")).toBe(true);
    expect(canTransition("concluded", "running")).toBe(false);
    expect(canTransition("approved", "concluded")).toBe(false);
  });
});

describe("audience guard", () => {
  it("rejects forbidden audiences", () => {
    for (const a of ["security", "consent", "pricing_disclosure"]) expect(isForbiddenAudience(a)).toBe(true);
    expect(isForbiddenAudience("public")).toBe(false);
  });
});

/* ── service (fake db) ────────────────────────────────────────────────── */

type Row = Record<string, any>;

/** Minimal chainable Supabase fake covering the experiments tables. */
function fakeDb(seed: { experiments?: Row[]; experiment_variants?: Row[]; experiment_assignments?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    experiments: seed.experiments ?? [],
    experiment_variants: seed.experiment_variants ?? [],
    experiment_assignments: seed.experiment_assignments ?? [],
  };
  const db = {
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      const match = (r: Row) => filters.every(([k, v]) => {
        if (k === "experiment_variants") return true;
        if (Array.isArray(v)) return v.includes(r[k]);
        if (v && typeof v === "object" && "isNull" in (v as object)) return r[k] === null || r[k] === undefined;
        return r[k] === v;
      });
      const attach = (r: Row) => {
        if (table === "experiments") {
          r.experiment_variants = tables.experiment_variants.filter((v) => v.experiment_id === r.id);
        }
        return r;
      };
      const run = async () => {
        const list = rows();
        if (op === "insert" && payload) {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted = items.map((p, i) => ({
            id: p.id ?? `00000000-0000-4000-8000-${String(list.length + i + 1).padStart(12, "0")}`,
            ...p,
          }));
          list.push(...inserted);
          return { data: inserted, error: null };
        }
        if (op === "upsert" && payload) {
          const p = payload as Row;
          const ex = list.find((r) => r.experiment_id === p.experiment_id && r.subject_hash === p.subject_hash);
          if (ex) Object.assign(ex, p); else list.push({ id: `a_${list.length + 1}`, ...p });
          return { data: null, error: null };
        }
        if (op === "update" && payload) {
          const hit = list.filter(match);
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit, error: null };
        }
        if (op === "delete") {
          const hit = list.filter(match);
          tables[table] = list.filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        return { data: list.filter(match).map(attach), error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (p: Row | Row[]) => { op = "insert"; payload = p; return q; };
      q.update = (p: Row) => { op = "update"; payload = p; return q; };
      q.upsert = (p: Row) => { op = "upsert"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
      q.is = (k: string, v: unknown) => { filters.push([k, v === null ? { isNull: true } : v]); return q; };
      q.in = (k: string, vs: unknown[]) => { filters.push([k, vs]); return q; };
      q.order = () => q; q.limit = () => q;
      q.maybeSingle = async () => { const r = await run(); return { data: (r.data as Row[])[0] ?? null, error: r.error }; };
      q.single = async () => { const r = await run(); return { data: (r.data as Row[])[0] ?? null, error: r.error }; };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
      return q;
    },
  };
  return { db: db as never, tables };
}

const STAFF = "22222222-2222-4222-8222-222222222222";
const input = {
  key: "hero_cta", name: "Hero CTA", hypothesis: "B wins", audience: "public",
  variants: [
    { key: "control", weight: 70, config: { headline: "Rent a bike" } },
    { key: "variant_a", weight: 30, config: { headline: "Try Zapnivo" } },
  ],
};

describe("experiments service", () => {
  it("rejects a forbidden audience before touching the db", async () => {
    const { db, tables } = fakeDb();
    const out = await createExperiment(db, { ...input, audience: "security" });
    expect(out.ok).toBe(false);
    expect(tables.experiments).toHaveLength(0);
  });

  it("rejects fewer than two variants and bad weights", async () => {
    const { db } = fakeDb();
    expect((await createExperiment(db, { ...input, variants: [input.variants[0]] })).ok).toBe(false);
    expect((await createExperiment(db, { ...input, variants: [{ key: "a", weight: 0 }, { key: "b", weight: 1 }] })).ok).toBe(false);
  });

  it("creates a draft with variants", async () => {
    const { db, tables } = fakeDb();
    const out = await createExperiment(db, { ...input, created_by: STAFF });
    expect(out.ok).toBe(true);
    expect(tables.experiments[0].status).toBe("draft");
    expect(tables.experiment_variants).toHaveLength(2);
  });

  it("blocks draft→running; approve then run works", async () => {
    const { db } = fakeDb();
    const created = await createExperiment(db, input);
    const id = created.ok ? created.data!.id : "";

    const blocked = await transition(db, id, "running", STAFF);
    expect(blocked.ok).toBe(false);

    const approved = await transition(db, id, "approved", STAFF);
    expect(approved.ok).toBe(true);

    const running = await transition(db, id, "running", STAFF);
    expect(running.ok).toBe(true);
    const exp = await getExperiment(db, "hero_cta");
    expect(exp?.status).toBe("running");
    expect(exp?.variants).toHaveLength(2);
  });

  it("assigns deterministically and is idempotent", async () => {
    const { db, tables } = fakeDb();
    await createExperiment(db, input);
    await transition(db, (tables.experiments[0] as Row).id, "approved", STAFF);
    await transition(db, (tables.experiments[0] as Row).id, "running", STAFF);

    const h = hashSubject("v1:hero_cta");
    const a1 = await assign(db, "hero_cta", h);
    const a2 = await assign(db, "hero_cta", h);
    expect(a1).not.toBeNull();
    expect(a2?.variant_key).toBe(a1?.variant_key);
    expect(a1?.config).toEqual(input.variants.find((v) => v.key === a1?.variant_key)!.config);
    expect(tables.experiment_assignments.filter((r) => r.subject_hash === subjectHashText(h))).toHaveLength(1);
  });

  it("never assigns for draft/paused/concluded/expired experiments", async () => {
    const { db, tables } = fakeDb();
    await createExperiment(db, input);
    const id = (tables.experiments[0] as Row).id as string;
    expect(await assign(db, "hero_cta", 7)).toBeNull(); // draft

    await transition(db, id, "approved", STAFF);
    await transition(db, id, "running", STAFF);
    expect(await assign(db, "hero_cta", 7)).not.toBeNull();

    await transition(db, id, "paused", STAFF);
    expect(await assign(db, "hero_cta", 8)).toBeNull(); // paused
    await transition(db, id, "concluded", STAFF);
    expect(await assign(db, "hero_cta", 9)).toBeNull(); // concluded

    // expired window
    tables.experiments[0].end_at = "2000-01-01T00:00:00Z";
    tables.experiments[0].status = "running";
    expect(await assign(db, "hero_cta", 10)).toBeNull();
  });

  it("records exposure and conversion once, and reports real counts", async () => {
    const { db, tables } = fakeDb();
    await createExperiment(db, input);
    const id = (tables.experiments[0] as Row).id as string;
    await transition(db, id, "approved", STAFF);
    await transition(db, id, "running", STAFF);

    const h = hashSubject("v2:hero_cta");
    const a = await assign(db, "hero_cta", h);
    expect(a).not.toBeNull();
    await recordExposure(db, id, h);
    await recordExposure(db, id, h); // idempotent
    await recordConversion(db, id, h, "signup");
    await recordConversion(db, id, h, "signup");

    const row = tables.experiment_assignments[0];
    expect(row.exposed_at).toBeTruthy();
    expect(row.converted_at).toBeTruthy();

    const res = await results(db, id);
    expect(res).toHaveLength(2);
    const mine = res.find((r) => r.variant_key === a!.variant_key)!;
    expect(mine.assigned).toBe(1);
    expect(mine.exposed).toBe(1);
    expect(mine.converted).toBe(1);
    expect(mine.conversion_rate).toBe(1);
    const other = res.find((r) => r.variant_key !== a!.variant_key)!;
    expect(other.assigned).toBe(0);
    expect(other.conversion_rate).toBeNull(); // no data, not a fabricated 0%
  });
});
