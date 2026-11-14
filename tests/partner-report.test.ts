import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  csvCell, deviceStatusSummary, paymentWindowStats, pctDelta, rentalWindowStats, toCsv,
} from "../src/lib/partner-ops";
import { loadOrgReport } from "../src/lib/partner-ops-data";

/* ─── Pure helpers ─────────────────────────────────────────────────────── */

describe("rentalWindowStats", () => {
  const rows = [
    { state: "active", created_at: "2025-06-10T00:00:00Z" },   // current window
    { state: "returned", created_at: "2025-06-20T00:00:00Z" },  // current window
    { state: "authorized", created_at: "2025-06-25T00:00:00Z" },// current window, not dispensed
    { state: "active", created_at: "2025-05-20T00:00:00Z" },   // prior window
    { state: "cancelled", created_at: "2025-04-01T00:00:00Z" },// outside both
  ];
  it("counts window rentals and utilization", () => {
    const cur = rentalWindowStats(rows, "2025-06-01T00:00:00Z", "2025-07-01T00:00:00Z");
    expect(cur).toEqual({ rentals: 3, completed: 2, utilizationPct: 66.7 });
    const prior = rentalWindowStats(rows, "2025-05-01T00:00:00Z", "2025-06-01T00:00:00Z");
    expect(prior).toEqual({ rentals: 1, completed: 1, utilizationPct: 100 });
  });
  it("returns null utilization on an empty window", () => {
    expect(rentalWindowStats([], "2025-06-01T00:00:00Z", "2025-07-01T00:00:00Z").utilizationPct).toBeNull();
  });
});

describe("paymentWindowStats", () => {
  it("nets captured minus refunded inside the window only", () => {
    const rows = [
      { amount_captured_cents: 1000, amount_refunded_cents: 200, created_at: "2025-06-05T00:00:00Z" },
      { amount_captured_cents: 500, amount_refunded_cents: null, created_at: "2025-06-15T00:00:00Z" },
      { amount_captured_cents: 9999, amount_refunded_cents: 0, created_at: "2025-01-01T00:00:00Z" },
    ];
    expect(paymentWindowStats(rows, "2025-06-01T00:00:00Z", "2025-07-01T00:00:00Z")).toEqual({ payments: 2, netCents: 1300 });
  });
});

describe("pctDelta", () => {
  it("computes percent change and handles zero baselines", () => {
    expect(pctDelta(150, 100)).toBe(50);
    expect(pctDelta(50, 100)).toBe(-50);
    expect(pctDelta(0, 0)).toBe(0);
    expect(pctDelta(10, 0)).toBeNull();
  });
});

describe("deviceStatusSummary", () => {
  const now = new Date("2025-06-15T12:00:00Z");
  const fresh = "2025-06-15T06:00:00Z";
  const old = "2025-06-10T00:00:00Z";
  it("splits online / stale / inactive", () => {
    const s = deviceStatusSummary([
      { status: "active", last_heartbeat_at: fresh },
      { status: "active", last_heartbeat_at: old },
      { status: "active", last_heartbeat_at: null },
      { status: "maintenance", last_heartbeat_at: fresh },
      { status: "suspended", last_heartbeat_at: null },
    ], now);
    expect(s).toEqual({ total: 5, online: 1, stale: 2, inactive: 2 });
  });
});

describe("toCsv / csvCell", () => {
  it("quotes every cell per RFC 4180", () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(42)).toBe('"42"');
  });
  it("neutralizes spreadsheet formula injection", () => {
    for (const evil of ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
      const out = csvCell(evil);
      expect(out.startsWith(`"'`)).toBe(true);
    }
  });
  it("builds header + rows and emits no_rows for empty input", () => {
    expect(toCsv([])).toBe("no_rows\n");
    const csv = toCsv([{ a: "x,y", b: "=HYPERLINK(\"http://evil\")" }]);
    expect(csv).toContain("a,b");
    expect(csv).toContain('"x,y"');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

/* ─── loadOrgReport org-scoping ────────────────────────────────────────── */

type Call = { table: string; method: string; args: unknown[] };

/** Chainable Supabase mock: records every filter call, resolves fixtures at .limit(). */
function mockDb(fixtures: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: (...args: unknown[]) => { calls.push({ table, method: "eq", args }); return builder; },
        in: (...args: unknown[]) => { calls.push({ table, method: "in", args }); return builder; },
        gte: (...args: unknown[]) => { calls.push({ table, method: "gte", args }); return builder; },
        lt: (...args: unknown[]) => { calls.push({ table, method: "lt", args }); return builder; },
        order: () => builder,
        limit: () => Promise.resolve({ data: fixtures[table] ?? [], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
  return db;
}

const NOW = new Date("2025-06-15T12:00:00Z");
const ORG = "org-1";
const VENUES = [{ id: "v1", name: "Tavern", published: true }, { id: "v2", name: "Cafe", published: false }];

function reportFixtures() {
  return {
    venues: VENUES,
    rentals: [
      { state: "active", created_at: "2025-06-10T00:00:00Z", kiosks: { venue_id: "v1" } },
      { state: "returned", created_at: "2025-06-12T00:00:00Z", kiosks: { venue_id: "v2" } },
      { state: "active", created_at: "2025-05-10T00:00:00Z", kiosks: { venue_id: "v1" } },
    ],
    payments: [
      { amount_captured_cents: 1200, amount_refunded_cents: 200, created_at: "2025-06-11T00:00:00Z", rentals: { kiosks: { venue_id: "v1" } } },
      { amount_captured_cents: 800, amount_refunded_cents: null, created_at: "2025-05-10T00:00:00Z", rentals: { kiosks: { venue_id: "v1" } } },
    ],
    commission_ledgers: [
      { period: "2025-05-01", gross_cents: 5000, commission_cents: 500 },
      { period: "2025-06-01", gross_cents: 7000, commission_cents: 700 },
    ],
    payout_records: [
      { amount_cents: 500, status: "paid", paid_at: "2025-06-01T00:00:00Z", created_at: "2025-06-01T00:00:00Z", commission_ledgers: { venue_id: "v1" } },
      { amount_cents: 300, status: "scheduled", paid_at: null, created_at: "2025-06-10T00:00:00Z", commission_ledgers: { venue_id: "v2" } },
      { amount_cents: 100, status: "failed", paid_at: null, created_at: "2025-06-11T00:00:00Z", commission_ledgers: { venue_id: "v1" } },
    ],
    support_tickets: [{ id: "t1", state: "open" }, { id: "t2", state: "pending_customer" }],
    system_devices: [
      { status: "active", last_heartbeat_at: "2025-06-15T06:00:00Z" },
      { status: "active", last_heartbeat_at: "2025-06-01T00:00:00Z" },
      { status: "maintenance", last_heartbeat_at: null },
    ],
  };
}

describe("loadOrgReport", () => {
  it("scopes every query to the caller's organization/venues", async () => {
    const db = mockDb(reportFixtures());
    await loadOrgReport(db as never, ORG, NOW);
    const has = (table: string, method: string, ...args: unknown[]) =>
      db.calls.some((c) => c.table === table && c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)));

    expect(has("venues", "eq", "organization_id", ORG)).toBe(true);
    for (const table of ["rentals", "payments"]) {
      const venueArg = table === "rentals" ? "kiosks.venue_id" : "rentals.kiosks.venue_id";
      expect(has(table, "in", venueArg, ["v1", "v2"])).toBe(true);
    }
    expect(has("commission_ledgers", "in", "venue_id", ["v1", "v2"])).toBe(true);
    expect(has("payout_records", "in", "commission_ledgers.venue_id", ["v1", "v2"])).toBe(true);
    expect(has("system_devices", "in", "venue_id", ["v1", "v2"])).toBe(true);
    expect(has("support_tickets", "eq", "organization_id", ORG)).toBe(true);
    // No unscoped table scans.
    expect(db.calls.filter((c) => c.table === "rentals" && c.method === "eq")).toHaveLength(0);
  });

  it("assembles metrics from org rows only", async () => {
    const db = mockDb(reportFixtures());
    const r = await loadOrgReport(db as never, ORG, NOW);
    expect(r.current.rentals).toBe(2);
    expect(r.current.completed).toBe(2);
    expect(r.current.utilizationPct).toBe(100);
    expect(r.current.revenueCents).toBe(1000); // 1200 - 200
    expect(r.prior.rentals).toBe(1);
    expect(r.prior.revenueCents).toBe(800);
    expect(r.deltas.rentalsPct).toBe(100);
    expect(r.deltas.revenuePct).toBe(25);
    expect(r.commission).toMatchObject({ grossCents: 12000, commissionCents: 1200, periods: 2, latestPeriod: "2025-06-01" });
    expect(r.payouts).toMatchObject({ count: 3, scheduledCents: 300, paidCents: 500, failed: 1 });
    expect(r.openTickets).toBe(2);
    expect(r.devices).toEqual({ total: 3, online: 1, stale: 1, inactive: 1 });
    expect(r.venues).toHaveLength(2);
  });

  it("returns honest zeros when the org has no venues", async () => {
    const db = mockDb({ venues: [], support_tickets: [] });
    const r = await loadOrgReport(db as never, ORG, NOW);
    expect(r.current.rentals).toBe(0);
    expect(r.devices.total).toBe(0);
    expect(r.commission.periods).toBe(0);
    // Venue-scoped tables must not be queried at all without venue ids.
    expect(db.calls.filter((c) => ["rentals", "payments", "commission_ledgers", "payout_records", "system_devices"].includes(c.table))).toHaveLength(0);
  });
});

/* ─── GET /api/partners/reports/rentals.csv ────────────────────────────── */

const { session, dbHolder } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbHolder: { db: null as unknown },
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => session.user,
  isStaff: (u: { role: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => dbHolder.db, anonClient: () => null, backendConfigured: () => true }));

describe("GET /api/partners/reports/rentals.csv", () => {
  beforeEach(() => {
    session.user = null;
    dbHolder.db = null;
  });

  it("rejects signed-out and non-partner callers", async () => {
    const { GET } = await import("../src/app/api/partners/reports/rentals.csv/route");
    expect((await GET()).status).toBe(403);
    session.user = { id: "u1", email: "c@x.com", role: "customer", organizationId: null };
    expect((await GET()).status).toBe(403);
    session.user = { id: "u2", email: "p@x.com", role: "partner", organizationId: null };
    expect((await GET()).status).toBe(403); // no org linked
  });

  it("streams an org-scoped, escaped CSV for partners and staff", async () => {
    session.user = { id: "u3", email: "p@x.com", role: "partner", organizationId: ORG };
    const db = mockDb({
      venues: [{ id: "v1" }],
      rentals: [
        {
          reference: "ZR-ABC123", state: "returned", created_at: "2025-06-01T00:00:00Z",
          started_at: null, dispensed_at: "2025-06-01T01:00:00Z", returned_at: "2025-06-01T03:00:00Z",
          non_return_deadline: null, accrued_charge_cents: 500,
          kiosks: { station_id: "ST-1", venues: { name: "=Evil Venue" } },
        },
      ],
    });
    dbHolder.db = db;
    const { GET } = await import("../src/app/api/partners/reports/rentals.csv/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("rentals");
    const text = await res.text();
    expect(text).toContain("reference,state,station_id,venue");
    expect(text).toContain("ZR-ABC123");
    expect(text).toContain(`"'=Evil Venue"`);
    // Org scoping: venue lookup by organization_id, rentals restricted to that venue.
    expect(db.calls.some((c) => c.table === "venues" && c.method === "eq" && c.args[0] === "organization_id" && c.args[1] === ORG)).toBe(true);
    expect(db.calls.some((c) => c.table === "rentals" && c.method === "in" && c.args[0] === "kiosks.venue_id" && JSON.stringify(c.args[1]) === '["v1"]')).toBe(true);
  });

  it("allows staff sessions", async () => {
    session.user = { id: "u4", email: "s@x.com", role: "staff", organizationId: ORG };
    dbHolder.db = mockDb({ venues: [], rentals: [] });
    const { GET } = await import("../src/app/api/partners/reports/rentals.csv/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("no_rows\n");
  });
});
