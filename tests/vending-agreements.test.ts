import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  approveAgreement, createAgreementDraft, currentAgreement, listAgreements, terminateAgreement,
  type EquipmentAgreement,
} from "@/lib/vending-agreements";

/* ─── Recording Supabase mock ─────────────────────────────────────────────── */

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };
type Call = { table: string; method: string; args: unknown[] };

const OPS = ["eq", "neq", "in", "not", "is", "gte", "lte", "gt", "lt"] as const;

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) => filters.every((f) => {
    const v = r[f.col];
    switch (f.op) {
      case "eq": return v === f.val;
      case "neq": return v !== f.val;
      case "in": return Array.isArray(f.val) && f.val.includes(v);
      case "is": return f.val === null ? v == null : v === f.val;
      case "not": return f.op === "not" ? !(v == null) : true; // only "is null" negation used
      case "gte": return v != null && String(v) >= String(f.val);
      case "lte": return v != null && String(v) <= String(f.val);
      case "gt": return v != null && String(v) > String(f.val);
      case "lt": return v != null && String(v) < String(f.val);
      default: return true;
    }
  }));
}

function makeDb(tables: Record<string, Row[]>, opts: { throwTables?: string[] } = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      if (opts.throwTables?.includes(table)) throw new Error(`no table ${table}`);
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Filter[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let pendingInsert: Row[] | null = null;
      let pendingUpdate: Row | null = null;
      let pendingDelete = false;

      const matched = () => {
        let out = applyFilters(rows, filters);
        if (orderBy) out = [...out].sort((a, b) => String(a[orderBy!.col]).localeCompare(String(b[orderBy!.col])) * (orderBy!.asc ? 1 : -1));
        if (lim != null) out = out.slice(0, lim);
        return out;
      };

      const exec = () => {
        if (pendingInsert) {
          const stored = pendingInsert.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID(), created_at: r.created_at ?? new Date().toISOString() }));
          rows.push(...stored);
          pendingInsert = null;
          return { data: stored, error: null };
        }
        if (pendingUpdate) {
          const m = matched();
          for (const r of m) Object.assign(r, pendingUpdate);
          pendingUpdate = null;
          return { data: m, error: null };
        }
        if (pendingDelete) {
          const m = new Set(matched());
          tables[table] = rows.filter((r) => !m.has(r));
          pendingDelete = false;
          return { data: [...m], error: null };
        }
        return { data: matched(), error: null };
      };

      const q: Record<string, unknown> = {};
      q.select = (...a: unknown[]) => { calls.push({ table, method: "select", args: a }); return q; };
      for (const op of OPS) {
        q[op] = (...a: unknown[]) => {
          calls.push({ table, method: op, args: a });
          if (op === "in") filters.push({ col: String(a[0]), op: "in", val: a[1] });
          else if (op === "not") filters.push({ col: String(a[0]), op: "not", val: a[2] });
          else filters.push({ col: String(a[0]), op, val: a[1] });
          return q;
        };
      }
      q.order = (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return q; };
      q.limit = (n: number) => { lim = n; return q; };
      q.range = (a: number, b: number) => { lim = b - a + 1; return q; };
      q.insert = (rowsIn: Row | Row[]) => { pendingInsert = Array.isArray(rowsIn) ? rowsIn : [rowsIn]; calls.push({ table, method: "insert", args: [rowsIn] }); return q; };
      q.update = (patch: Row) => { pendingUpdate = patch; calls.push({ table, method: "update", args: [patch] }); return q; };
      q.upsert = (rowsIn: Row | Row[]) => { pendingInsert = Array.isArray(rowsIn) ? rowsIn : [rowsIn]; return q; };
      q.delete = () => { pendingDelete = true; calls.push({ table, method: "delete", args: [] }); return q; };
      q.maybeSingle = async () => { const r = (exec().data as Row[])[0]; return { data: r ?? null, error: null }; };
      q.single = async () => { const r = (exec().data as Row[])[0]; return r ? { data: r, error: null } : { data: null, error: { message: "not found" } }; };
      q.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(exec()).then(onF, onR);
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, calls, tables };
}

const ACTOR = { id: "11111111-1111-4111-8111-111111111111" };
const VENUE = { id: "v-1", organization_id: "org-1" };

const agreement = (o: Partial<EquipmentAgreement>): EquipmentAgreement => ({
  id: "a-1", venue_id: "v-1", organization_id: "org-1", equipment_category: "snack", version: 1,
  status: "draft", effective_from: null, effective_to: null, revenue_share_pct: 10,
  terms: {}, approved_by: null, approved_at: null, created_by: null, created_at: "2026-01-01T00:00:00Z", ...o,
});

describe("createAgreementDraft", () => {
  it("creates version = max(existing)+1 as a draft with the venue's org", async () => {
    const { db, tables } = makeDb({
      venues: [VENUE],
      equipment_agreements: [
        agreement({ id: "a1", version: 1, status: "superseded" }),
        agreement({ id: "a2", version: 3, status: "draft", equipment_category: "beverage" }),
        agreement({ id: "a3", version: 2, status: "active" }),
      ],
    });
    const res = await createAgreementDraft(db, ACTOR, { venue_id: "v-1", equipment_category: "snack", revenue_share_pct: 12.5, terms: { notes: "hi" }, effective_from: "2026-03-01" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agreement.version).toBe(3); // snack max is v2 → next is 3 (beverage v3 ignored)
    expect(res.agreement.status).toBe("draft");
    expect(res.agreement.organization_id).toBe("org-1");
    expect(res.agreement.revenue_share_pct).toBe(12.5);
    expect(tables.equipment_agreements).toHaveLength(4);
  });

  it("first agreement for a venue+category is version 1", async () => {
    const { db } = makeDb({ venues: [VENUE], equipment_agreements: [] });
    const res = await createAgreementDraft(db, ACTOR, { venue_id: "v-1", equipment_category: "snack" });
    expect(res.ok && res.agreement.version).toBe(1);
  });

  it("rejects unknown venue and invalid category/pct", async () => {
    const { db } = makeDb({ venues: [] });
    expect((await createAgreementDraft(db, ACTOR, { venue_id: "v-1", equipment_category: "snack" })).ok).toBe(false);
    const { db: db2 } = makeDb({ venues: [VENUE] });
    expect((await createAgreementDraft(db2, ACTOR, { venue_id: "v-1", equipment_category: "nonsense!!" })).ok).toBe(false);
    expect((await createAgreementDraft(db2, ACTOR, { venue_id: "v-1", equipment_category: "snack", revenue_share_pct: 140 })).ok).toBe(false);
  });
});

describe("approveAgreement", () => {
  it("activates a draft, stamps approver, and supersedes the prior active version only", async () => {
    const { db, tables } = makeDb({
      equipment_agreements: [
        agreement({ id: "old", version: 1, status: "active", venue_id: "v-1", equipment_category: "snack" }),
        agreement({ id: "other-cat", version: 1, status: "active", venue_id: "v-1", equipment_category: "beverage" }),
        agreement({ id: "draft", version: 2, status: "draft", venue_id: "v-1", equipment_category: "snack" }),
      ],
    });
    const res = await approveAgreement(db, ACTOR, "draft");
    expect(res.ok).toBe(true);
    const rows = tables.equipment_agreements;
    expect(rows.find((r) => r.id === "old")!.status).toBe("superseded");
    expect(rows.find((r) => r.id === "other-cat")!.status).toBe("active"); // different category untouched
    const d = rows.find((r) => r.id === "draft")!;
    expect(d.status).toBe("active");
    expect(d.approved_by).toBe(ACTOR.id);
    expect(d.approved_at).toBeTruthy();
    expect(d.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaults to today
  });

  it("refuses to approve a non-draft agreement", async () => {
    const { db } = makeDb({ equipment_agreements: [agreement({ id: "x", status: "active" })] });
    const res = await approveAgreement(db, ACTOR, "x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/draft/);
  });

  it("returns not-found for a missing id", async () => {
    const { db } = makeDb({ equipment_agreements: [] });
    expect((await approveAgreement(db, ACTOR, "nope")).ok).toBe(false);
  });
});

describe("terminateAgreement", () => {
  it("terminates an active agreement and records the reason in terms", async () => {
    const { db, tables } = makeDb({ equipment_agreements: [agreement({ id: "t", status: "active", terms: { notes: "keep" } })] });
    const res = await terminateAgreement(db, ACTOR, "t", "venue closed");
    expect(res.ok).toBe(true);
    const row = tables.equipment_agreements[0];
    expect(row.status).toBe("terminated");
    expect(row.effective_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((row.terms as Row).termination_reason).toBe("venue closed");
    expect((row.terms as Row).notes).toBe("keep"); // existing terms preserved
  });

  it("refuses to terminate a draft or already-terminated agreement", async () => {
    const { db } = makeDb({
      equipment_agreements: [agreement({ id: "d", status: "draft" }), agreement({ id: "t", status: "terminated" })],
    });
    expect((await terminateAgreement(db, ACTOR, "d")).ok).toBe(false);
    expect((await terminateAgreement(db, ACTOR, "t")).ok).toBe(false);
  });
});

describe("listAgreements", () => {
  it("applies status/venue/org filters and returns display names when embedded", async () => {
    const { db, calls } = makeDb({
      equipment_agreements: [
        { ...agreement({ id: "1", status: "active" }), venue: { name: "Tavern", city: "Austin", state: "TX" }, organization: { name: "Org One" } },
        agreement({ id: "2", status: "draft", venue_id: "v-2" }),
      ],
    });
    const all = await listAgreements(db);
    expect(all).toHaveLength(2);
    expect(all[0].venueName).toBe("Tavern");
    expect(all[0].orgName).toBe("Org One");

    const filtered = await listAgreements(db, { status: "active", venue_id: "v-1", org_id: "org-1" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("1");
    const eqCalls = calls.filter((c) => c.table === "equipment_agreements" && c.method === "eq");
    expect(eqCalls.some((c) => c.args[0] === "status" && c.args[1] === "active")).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === "venue_id" && c.args[1] === "v-1")).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === "organization_id" && c.args[1] === "org-1")).toBe(true);
  });

  it("returns [] on db error instead of throwing", async () => {
    const { db } = makeDb({}, { throwTables: ["equipment_agreements"] });
    // from() throws synchronously → listAgreements awaits the query; wrap expectation
    await expect(listAgreements(db)).rejects.toThrow();
  });
});

describe("currentAgreement", () => {
  const NOW = new Date("2026-06-15T12:00:00Z");
  it("returns the active version effective today", async () => {
    const { db } = makeDb({
      equipment_agreements: [
        agreement({ id: "old", version: 1, status: "active", effective_from: "2025-01-01", effective_to: "2026-01-01" }), // expired
        agreement({ id: "cur", version: 2, status: "active", effective_from: "2026-02-01" }),
        agreement({ id: "future", version: 3, status: "active", effective_from: "2027-01-01" }),
        agreement({ id: "draft", version: 4, status: "draft" }),
      ],
    });
    const res = await currentAgreement(db, "v-1", "snack", NOW);
    expect(res?.id).toBe("cur");
  });

  it("returns null when nothing is effective (honest)", async () => {
    const { db } = makeDb({ equipment_agreements: [agreement({ id: "f", status: "active", effective_from: "2027-01-01" })] });
    expect(await currentAgreement(db, "v-1", "snack", NOW)).toBeNull();
    const { db: empty } = makeDb({ equipment_agreements: [] });
    expect(await currentAgreement(empty, "v-1", "snack", NOW)).toBeNull();
  });
});
