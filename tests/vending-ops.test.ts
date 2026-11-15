import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createServiceRequestForOrg, listOrgServiceRequests, loadVendingOpsDashboard, orgVenueIds,
} from "@/lib/vending-ops";

/* ─── Recording Supabase mock (same shape as vending-agreements.test.ts) ───── */

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
      case "not": return !(v == null); // only "is null" negation is used
      case "gte": return v != null && String(v) >= String(f.val);
      case "lte": return v != null && String(v) <= String(f.val);
      case "gt": return v != null && String(v) > String(f.val);
      case "lt": return v != null && String(v) < String(f.val);
      default: return true;
    }
  }));
}

function makeDb(tables: Record<string, Row[]>, opts: { throwTables?: string[]; errorTables?: string[] } = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      if (opts.throwTables?.includes(table)) throw new Error(`no table ${table}`);
      const rows = tables[table] ?? (tables[table] = []);
      const fail = opts.errorTables?.includes(table);
      const filters: Filter[] = [];
      let orderBy: { col: string; asc: boolean } | null = null;
      let lim: number | null = null;
      let pendingInsert: Row[] | null = null;
      let pendingUpdate: Row | null = null;

      const matched = () => {
        let out = applyFilters(rows, filters);
        if (orderBy) out = [...out].sort((a, b) => String(a[orderBy!.col]).localeCompare(String(b[orderBy!.col])) * (orderBy!.asc ? 1 : -1));
        if (lim != null) out = out.slice(0, lim);
        return out;
      };
      const exec = () => {
        if (fail) return { data: null, error: { message: `boom ${table}` } };
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
      q.insert = (rowsIn: Row | Row[]) => { pendingInsert = Array.isArray(rowsIn) ? rowsIn : [rowsIn]; calls.push({ table, method: "insert", args: [rowsIn] }); return q; };
      q.update = (patch: Row) => { pendingUpdate = patch; return q; };
      q.delete = () => { calls.push({ table, method: "delete", args: [] }); return q; };
      q.maybeSingle = async () => { const r = (exec().data as Row[] | null)?.[0]; return { data: r ?? null, error: fail ? { message: "boom" } : null }; };
      q.single = async () => { const r = (exec().data as Row[] | null)?.[0]; return r ? { data: r, error: null } : { data: null, error: { message: "not found" } }; };
      q.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(exec()).then(onF, onR);
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, calls, tables };
}

const NOW = new Date("2026-06-15T12:00:00Z");
const OLD = "2026-05-01T00:00:00Z";   // >30d before NOW
const RECENT = "2026-06-10T00:00:00Z"; // within 30d

describe("loadVendingOpsDashboard", () => {
  const fullTables = (): Record<string, Row[]> => ({
    partner_applications: [
      { id: "p1", business_name: "Tavern", placement_stage: "inquiry", created_at: RECENT },
      { id: "p2", business_name: "Gym", placement_stage: "proposal", created_at: RECENT },
      { id: "p3", business_name: "Old", placement_stage: "installed", created_at: OLD },
      { id: "p4", business_name: "Bar", placement_stage: "inquiry", created_at: OLD },
    ],
    equipment_units: [
      { id: "u1", status: "active", category: "snack", venue_id: "v1" },
      { id: "u2", status: "active", category: "beverage", venue_id: "v1" },
      { id: "u3", status: "sourcing", category: "snack", venue_id: null },
      { id: "u4", status: "ordered", category: "food", venue_id: null },
      { id: "u5", status: "assigned", category: "snack", venue_id: "v1", model_label: "SnackMax 40", serial_number: null },
      { id: "u6", status: "installed", category: "beverage", venue_id: "v2", model_label: null, serial_number: "SN-9" },
      { id: "u7", status: "retired", category: "trading_cards", venue_id: null },
    ],
    venues: [
      { id: "v1", name: "Demo Tavern", organization_id: "org-1" },
      { id: "v2", name: "City Gym", organization_id: "org-2" },
    ],
    equipment_models: [
      { id: "m1", status: "active" }, { id: "m2", status: "draft" }, { id: "m3", status: "active" },
    ],
    restock_visits: [
      { id: "r1", status: "planned", scheduled_for: "2026-06-20T00:00:00Z" },
      { id: "r2", status: "planned", scheduled_for: "2026-06-18T00:00:00Z" },
      { id: "r3", status: "in_progress", scheduled_for: null },
      { id: "r4", status: "completed", scheduled_for: "2026-06-01T00:00:00Z" },
    ],
    service_requests: [
      { id: "s1", venue_id: "v1", category: "repair", priority: "urgent", status: "new", created_at: RECENT },
      { id: "s2", venue_id: "v2", category: "restock", priority: "normal", status: "acknowledged", created_at: RECENT },
      { id: "s3", venue_id: "v1", category: "general", priority: "low", status: "completed", created_at: OLD },
    ],
    product_skus: [
      { id: "k1", reorder_point: 10, active: true },
      { id: "k2", reorder_point: 5, active: true },
      { id: "k3", reorder_point: 3, active: false },
    ],
    stock_levels: [
      { sku_id: "k1", qty: 4 },   // 4 <= 10 → low
      { sku_id: "k2", qty: 20 },  // fine
      { sku_id: "k3", qty: 0 },   // inactive sku — excluded
    ],
    equipment_agreements: [
      { id: "g1", status: "active" }, { id: "g2", status: "draft" },
      { id: "g3", status: "superseded" }, { id: "g4", status: "terminated" }, { id: "g5", status: "active" },
    ],
    commission_ledgers: [
      { period: "2026-05", gross_cents: 100000, commission_cents: 15000 },
      { period: "2026-05", gross_cents: 50000, commission_cents: 7500 },
      { period: "2026-04", gross_cents: 80000, commission_cents: 12000 },
    ],
    payout_records: [
      { amount_cents: 20000, status: "paid" },
      { amount_cents: 5000, status: "scheduled" },
      { amount_cents: 3000, status: "failed" },
    ],
  });

  it("aggregates every section from real rows", async () => {
    const { db } = makeDb(fullTables());
    const d = await loadVendingOpsDashboard(db, NOW);

    expect(d.placement?.inquiries30d).toBe(2); // p1, p2 only
    expect(d.placement?.stageCounts).toEqual({ inquiry: 2, proposal: 1, installed: 1 });
    expect(d.placement?.recent).toHaveLength(4);

    expect(d.units?.total).toBe(7);
    expect(d.units?.byStatus.active).toBe(2);
    expect(d.units?.byStatus.retired).toBe(1);
    expect(d.units?.byCategory.snack).toBe(3);

    expect(d.models).toEqual({ total: 3, byStatus: { active: 2, draft: 1 } });
    expect(d.sourcing).toEqual({ planned: 0, sourcing: 1, ordered: 1, received: 0 });

    expect(d.installations?.assigned).toBe(1);
    expect(d.installations?.installed).toBe(1);
    expect(d.installations?.upcoming).toHaveLength(2);
    const gymUnit = d.installations?.upcoming.find((u) => u.unitId === "u6");
    expect(gymUnit?.venueName).toBe("City Gym");
    expect(gymUnit?.label).toBe("SN-9"); // serial fallback when no model_label

    expect(d.restock).toEqual({ planned: 2, inProgress: 1, nextScheduled: "2026-06-18T00:00:00Z" });

    expect(d.serviceRequests?.open).toBe(2); // completed excluded
    expect(d.serviceRequests?.urgentOpen).toBe(1);
    expect(d.serviceRequests?.recent[0]?.venueName).toBe("Demo Tavern");

    expect(d.inventory).toEqual({ activeSkus: 2, lowStockSkus: 1 });
    expect(d.agreements).toEqual({ active: 2, drafts: 1, superseded: 1, terminated: 1 });

    expect(d.revenue).toEqual({ status: "unavailable", reason: "No vending transaction integration" });
    expect(d.partnerEarnings?.productLine).toBe("charging");
    expect(d.partnerEarnings?.ledgerPeriods).toBe(2);
    expect(d.partnerEarnings?.grossCents).toBe(230000);
    expect(d.partnerEarnings?.commissionCents).toBe(34500);
    expect(d.partnerEarnings?.payouts).toEqual({ scheduled: 1, paid: 1, failed: 1, paidCents: 20000, scheduledCents: 5000 });
  });

  it("degrades failing sections to null without breaking the rest", async () => {
    const { db } = makeDb(fullTables(), { throwTables: ["equipment_units", "restock_visits", "service_requests"] });
    const d = await loadVendingOpsDashboard(db, NOW);
    expect(d.units).toBeNull();
    expect(d.sourcing).toBeNull();
    expect(d.installations).toBeNull();
    expect(d.restock).toBeNull();
    expect(d.serviceRequests).toBeNull();
    expect(d.placement?.inquiries30d).toBe(2); // unaffected
    expect(d.revenue.status).toBe("unavailable");
  });

  it("degrades sections on query errors (not just throws)", async () => {
    const { db } = makeDb(fullTables(), { errorTables: ["product_skus"] });
    const d = await loadVendingOpsDashboard(db, NOW);
    expect(d.inventory).toBeNull();
    expect(d.agreements?.active).toBe(2);
  });

  it("returns all-null sections on a completely empty backend", async () => {
    const { db } = makeDb({});
    const d = await loadVendingOpsDashboard(db, NOW);
    expect(d.placement?.inquiries30d).toBe(0);
    expect(d.units?.total).toBe(0);
    expect(d.restock).toEqual({ planned: 0, inProgress: 0, nextScheduled: null });
    expect(d.inventory).toEqual({ activeSkus: 0, lowStockSkus: 0 });
    expect(d.partnerEarnings?.grossCents).toBe(0);
  });
});

describe("partner service requests — org scoping", () => {
  const ORG = "org-1";
  const USER = "user-1";
  const venues = [
    { id: "v1", organization_id: ORG, name: "Tavern" },
    { id: "v2", organization_id: "org-2", name: "Other" },
  ];
  const units = [
    { id: "u1", venue_id: "v1", category: "snack", status: "active" },
    { id: "u2", venue_id: "v2", category: "snack", status: "active" },
  ];

  it("orgVenueIds returns only that org's venues", async () => {
    const { db, calls } = makeDb({ venues });
    const ids = await orgVenueIds(db, ORG);
    expect(ids).toEqual(["v1"]);
    expect(calls.some((c) => c.table === "venues" && c.method === "eq" && c.args[1] === ORG)).toBe(true);
  });

  it("creates a request for a venue the org owns", async () => {
    const { db, tables } = makeDb({ venues, equipment_units: units, service_requests: [] });
    const res = await createServiceRequestForOrg(db, ORG, USER, {
      venue_id: "v1", unit_id: "u1", category: "repair", description: "Card reader keeps timing out at the bar.", priority: "high",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.request.status).toBe("new");
    expect(res.request.requested_by).toBe(USER);
    expect(res.request.priority).toBe("high");
    expect(tables.service_requests).toHaveLength(1);
  });

  it("rejects a venue owned by a different org (403-equivalent)", async () => {
    const { db, tables, calls } = makeDb({ venues, equipment_units: units, service_requests: [] });
    const res = await createServiceRequestForOrg(db, ORG, USER, {
      venue_id: "v2", category: "general", description: "This venue is not ours at all.",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/organization/i);
    expect(tables.service_requests).toHaveLength(0); // nothing inserted
    expect(calls.some((c) => c.table === "service_requests" && c.method === "insert")).toBe(false);
  });

  it("rejects a unit that isn't at the selected venue", async () => {
    const { db, tables } = makeDb({ venues, equipment_units: units, service_requests: [] });
    const res = await createServiceRequestForOrg(db, ORG, USER, {
      venue_id: "v1", unit_id: "u2", category: "repair", description: "Unit belongs to another venue entirely.",
    });
    expect(res.ok).toBe(false);
    expect(tables.service_requests).toHaveLength(0);
  });

  it("validates description length and defaults category/priority", async () => {
    const { db } = makeDb({ venues, equipment_units: units, service_requests: [] });
    expect((await createServiceRequestForOrg(db, ORG, USER, { venue_id: "v1", category: "general", description: "short" })).ok).toBe(false);
    const res = await createServiceRequestForOrg(db, ORG, USER, { venue_id: "v1", category: "bogus", description: "A perfectly reasonable description.", priority: "bogus" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.category).toBe("general");
      expect(res.request.priority).toBe("normal");
    }
  });

  it("listOrgServiceRequests scopes to org venues only", async () => {
    const { db, tables, calls } = makeDb({
      venues,
      service_requests: [
        { id: "s1", venue_id: "v1", category: "repair", priority: "normal", status: "new", requested_by: USER, created_at: "2026-06-01T00:00:00Z" },
        { id: "s2", venue_id: "v2", category: "repair", priority: "normal", status: "new", requested_by: "other", created_at: "2026-06-02T00:00:00Z" },
      ],
    });
    const rows = await listOrgServiceRequests(db, ORG);
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    expect(calls.some((c) => c.table === "service_requests" && c.method === "in" && (c.args[1] as string[]).includes("v1"))).toBe(true);
    expect(tables.service_requests).toHaveLength(2); // read-only, nothing mutated
  });

  it("listOrgServiceRequests returns [] when the org has no venues", async () => {
    const { db } = makeDb({ venues: [], service_requests: [] });
    expect(await listOrgServiceRequests(db, "org-empty")).toEqual([]);
  });
});
