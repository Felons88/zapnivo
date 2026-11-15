import { describe, expect, it } from "vitest";
import {
  agreementWindow, canTransition, computePartnerEarnings, deriveSettlementState,
  isPayoutMethod, isPayoutStatus, loadSettlementBoard, payoutTransitionPatch,
  statementCsv, transitionPayout, PAYOUT_TRANSITIONS,
} from "../src/lib/settlement";

/* ─── Transition legality ───────────────────────────────────────────────── */

describe("payout transition legality", () => {
  it("allows exactly the documented moves", () => {
    expect(canTransition("scheduled", "approved")).toBe(true);
    expect(canTransition("scheduled", "cancelled")).toBe(true);
    expect(canTransition("approved", "paid")).toBe(true);
    expect(canTransition("approved", "failed")).toBe(true);
    expect(canTransition("approved", "cancelled")).toBe(true);
    // Illegal / terminal moves
    for (const bad of [
      ["scheduled", "paid"], ["scheduled", "failed"], ["approved", "approved"],
      ["paid", "failed"], ["failed", "scheduled"], ["cancelled", "scheduled"],
      ["paid", "approved"],
    ] as const) expect(canTransition(bad[0], bad[1])).toBe(false);
    for (const s of ["paid", "failed", "cancelled"] as const) expect(PAYOUT_TRANSITIONS[s]).toHaveLength(0);
  });

  it("rejects an illegal patch with an explanatory error", () => {
    const r = payoutTransitionPatch("scheduled", "paid", { providerReference: "ACH-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot move/i);
  });

  it("stamps approved_by/approved_at when approving", () => {
    const now = new Date("2025-07-02T12:00:00Z");
    const r = payoutTransitionPatch("scheduled", "approved", { actorId: "admin-1" }, now);
    expect(r).toEqual({ ok: true, patch: { status: "approved", approved_by: "admin-1", approved_at: now.toISOString() } });
  });

  it("rejects unknown payout methods", () => {
    expect(isPayoutMethod("ach")).toBe(true);
    expect(isPayoutMethod("wire")).toBe(false);
    const r = payoutTransitionPatch("approved", "paid", { providerReference: "X", method: "wire" });
    expect(r.ok).toBe(false);
  });

  it("paid requires a non-empty provider reference", () => {
    for (const ref of [undefined, null, "", "   "]) {
      const r = payoutTransitionPatch("approved", "paid", { providerReference: ref });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/provider_reference/);
    }
    const ok = payoutTransitionPatch("approved", "paid", { providerReference: "  ACH-9921 ", method: "ach", actorId: "a" }, new Date("2025-07-03T00:00:00Z"));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.patch).toMatchObject({ status: "paid", provider_reference: "ACH-9921", method: "ach", paid_at: "2025-07-03T00:00:00.000Z" });
      expect(ok.patch.approved_by).toBeUndefined(); // approval fields untouched by a later transition
    }
  });

  it("failed and cancelled carry no payment fields", () => {
    const r = payoutTransitionPatch("approved", "failed", {}, new Date("2025-07-04T00:00:00Z"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch).toEqual({ status: "failed" });
    const c = payoutTransitionPatch("scheduled", "cancelled");
    expect(c.ok && c.patch.status === "cancelled").toBe(true);
  });
});

/* ─── transitionPayout against a recording mock ─────────────────────────── */

type Call = { table: string; method: string; args: unknown[] };

/** Chainable Supabase mock: records calls; maybeSingle returns fixtures[singleKey] or the updated row. */
function mockDb(fixtures: Record<string, unknown[]>, singles: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      const builder = {
        select: () => builder,
        eq: (...args: unknown[]) => { calls.push({ table, method: "eq", args }); return builder; },
        in: (...args: unknown[]) => { calls.push({ table, method: "in", args }); return builder; },
        gte: (...args: unknown[]) => { calls.push({ table, method: "gte", args }); return builder; },
        lt: (...args: unknown[]) => { calls.push({ table, method: "lt", args }); return builder; },
        order: () => builder,
        limit: () => Promise.resolve({ data: fixtures[table] ?? [], error: null }),
        insert: (row: unknown) => { calls.push({ table, method: "insert", args: [row] }); return Promise.resolve({ data: { id: "new-id" }, error: null }); },
        update: (p: Record<string, unknown>) => { patch = p; calls.push({ table, method: "update", args: [p] }); return builder; },
        maybeSingle: () => {
          if (patch) {
            const base = (singles[table] ?? {}) as Record<string, unknown>;
            return Promise.resolve({ data: { ...base, ...patch }, error: null });
          }
          return Promise.resolve({ data: singles[table] ?? null, error: null });
        },
        single: () => Promise.resolve({ data: singles[table] ?? null, error: null }),
      };
      return builder;
    },
  };
  return db;
}

describe("transitionPayout", () => {
  it("returns 404 for a missing payout", async () => {
    const db = mockDb({}, {});
    const r = await transitionPayout(db as never, "p-x", "approved");
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("guards the update on the current status (optimistic concurrency)", async () => {
    const db = mockDb({}, { payout_records: { id: "p1", status: "scheduled" } });
    const r = await transitionPayout(db as never, "p1", "approved", { actorId: "admin-9" });
    expect(r).toEqual({ ok: true, before: "scheduled", after: "approved" });
    const eqs = db.calls.filter((c) => c.table === "payout_records" && c.method === "eq");
    expect(eqs.some((c) => c.args[0] === "status" && c.args[1] === "scheduled")).toBe(true);
    const upd = db.calls.find((c) => c.method === "update");
    expect((upd!.args[0] as Record<string, unknown>).approved_by).toBe("admin-9");
  });

  it("refuses scheduled→paid even with a reference (must be approved first)", async () => {
    const db = mockDb({}, { payout_records: { id: "p1", status: "scheduled" } });
    const r = await transitionPayout(db as never, "p1", "paid", { providerReference: "ACH-1", method: "ach" });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(db.calls.filter((c) => c.method === "update")).toHaveLength(0);
  });
});

/* ─── Board state derivation ────────────────────────────────────────────── */

describe("deriveSettlementState / agreementWindow", () => {
  it("derives unbilled / accrued / payout states", () => {
    expect(deriveSettlementState(false, [])).toBe("unbilled");
    expect(deriveSettlementState(true, [])).toBe("accrued");
    expect(deriveSettlementState(true, [{ status: "scheduled" }])).toBe("scheduled");
    expect(deriveSettlementState(true, [{ status: "approved" }])).toBe("approved");
    expect(deriveSettlementState(true, [{ status: "paid" }])).toBe("paid");
    expect(deriveSettlementState(true, [{ status: "failed" }])).toBe("failed");
    expect(deriveSettlementState(true, [{ status: "cancelled" }])).toBe("cancelled");
    // paid outranks a stale scheduled row on the same ledger
    expect(deriveSettlementState(true, [{ status: "scheduled" }, { status: "paid" }])).toBe("paid");
  });

  it("reads pct + effective window from private terms", () => {
    const w = agreementWindow({ venue_id: "v1", signed_at: "2025-01-15", terms: { commission_pct: 12.5, effective_from: "2025-02-01", effective_to: "2025-12-31" } });
    expect(w).toMatchObject({ pct: 12.5, signedAt: "2025-01-15", effectiveFrom: "2025-02-01", effectiveTo: "2025-12-31", scope: "venue" });
    expect(agreementWindow({ venue_id: null, terms: { commission_pct: 10 } })?.scope).toBe("org");
    expect(agreementWindow(null)).toBeNull();
    expect(agreementWindow({ terms: { commission_pct: "lots" } })?.pct).toBeNull();
  });
});

/* ─── loadSettlementBoard ───────────────────────────────────────────────── */

const BOARD = "2025-06";
function boardFixtures() {
  return {
    venues: [
      { id: "v1", name: "Tavern", organization_id: "org-1", organizations: { name: "Brew Co" } },
      { id: "v2", name: "Cafe", organization_id: "org-1", organizations: [{ name: "Brew Co" }] },
      { id: "v3", name: "Bar", organization_id: null, organizations: null },
    ],
    partner_agreements: [
      { organization_id: "org-1", venue_id: null, terms: { commission_pct: 10 }, signed_at: "2025-01-01" },
      { organization_id: "org-1", venue_id: "v1", terms: { commission_pct: 20, effective_from: "2025-03-01" }, signed_at: "2025-02-01" },
    ],
    commission_ledgers: [
      { id: "l1", venue_id: "v1", period: "2025-06-01", gross_cents: 10000, commission_cents: 2000, statement_path: null },
      { id: "l2", venue_id: "v2", period: "2025-06-01", gross_cents: 5000, commission_cents: 500, statement_path: null },
    ],
    payout_records: [
      { id: "p1", ledger_id: "l1", amount_cents: 2000, status: "paid", method: "ach", provider_reference: "ACH-1", approved_by: "a", approved_at: "2025-07-01T00:00:00Z", paid_at: "2025-07-02T00:00:00Z", created_at: "2025-06-20T00:00:00Z" },
      { id: "p2", ledger_id: "l2", amount_cents: 500, status: "scheduled", method: null, provider_reference: null, approved_by: null, approved_at: null, paid_at: null, created_at: "2025-06-21T00:00:00Z" },
    ],
  };
}

describe("loadSettlementBoard", () => {
  it("returns one row per venue with derived states and agreement windows", async () => {
    const db = mockDb(boardFixtures());
    const rows = await loadSettlementBoard(db as never, BOARD);
    expect(rows).toHaveLength(3);
    const byVenue = new Map(rows.map((r) => [r.venueName, r]));
    expect(byVenue.get("Tavern")?.state).toBe("paid");
    expect(byVenue.get("Cafe")?.state).toBe("scheduled");
    expect(byVenue.get("Bar")?.state).toBe("unbilled");
    // venue-specific agreement beats org-wide
    expect(byVenue.get("Tavern")?.agreement?.pct).toBe(20);
    expect(byVenue.get("Tavern")?.agreement?.effectiveFrom).toBe("2025-03-01");
    expect(byVenue.get("Cafe")?.agreement?.pct).toBe(10);
    expect(byVenue.get("Bar")?.agreement).toBeNull();
    // payout detail carried through
    expect(byVenue.get("Tavern")?.payouts[0]).toMatchObject({ providerReference: "ACH-1", status: "paid", amountCents: 2000 });
  });

  it("filters ledgers to the requested period", async () => {
    const db = mockDb(boardFixtures());
    await loadSettlementBoard(db as never, "2025-06");
    const eqs = db.calls.filter((c) => c.table === "commission_ledgers" && c.method === "eq");
    expect(eqs.some((c) => c.args[0] === "period" && c.args[1] === "2025-06-01")).toBe(true);
  });
});

/* ─── computePartnerEarnings (org scoping) ──────────────────────────────── */

const ORG = "org-1";
function earningsFixtures() {
  return {
    venues: [{ id: "v1", name: "Tavern" }, { id: "v2", name: "Cafe" }],
    commission_ledgers: [
      { id: "l1", venue_id: "v1", period: "2025-05-01", gross_cents: 9000, commission_cents: 1800 },
      { id: "l2", venue_id: "v1", period: "2025-06-01", gross_cents: 10000, commission_cents: 2000 },
      { id: "l3", venue_id: "v2", period: "2025-06-01", gross_cents: 5000, commission_cents: 500 },
    ],
    partner_agreements: [
      { organization_id: ORG, venue_id: null, terms: { commission_pct: 10 }, signed_at: "2025-01-01" },
      { organization_id: ORG, venue_id: "v1", terms: { commission_pct: 20 }, signed_at: "2025-02-01" },
    ],
    payout_records: [
      { id: "p1", ledger_id: "l2", amount_cents: 2000, status: "paid", method: "ach", provider_reference: "ACH-9", approved_at: "2025-07-01T00:00:00Z", paid_at: "2025-07-02T00:00:00Z", created_at: "2025-06-20T00:00:00Z" },
      { id: "p2", ledger_id: "l3", amount_cents: 500, status: "scheduled", method: null, provider_reference: null, approved_at: null, paid_at: null, created_at: "2025-06-21T00:00:00Z" },
    ],
  };
}

describe("computePartnerEarnings", () => {
  it("scopes every query to the caller's organization/venues", async () => {
    const db = mockDb(earningsFixtures());
    await computePartnerEarnings(db as never, ORG, 6, new Date("2025-07-15T00:00:00Z"));
    const has = (table: string, method: string, ...args: unknown[]) =>
      db.calls.some((c) => c.table === table && c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)));
    expect(has("venues", "eq", "organization_id", ORG)).toBe(true);
    expect(has("commission_ledgers", "in", "venue_id", ["v1", "v2"])).toBe(true);
    expect(has("partner_agreements", "eq", "organization_id", ORG)).toBe(true);
    expect(has("payout_records", "in", "ledger_id", ["l1", "l2", "l3"])).toBe(true);
    // window bounded by months param
    expect(has("commission_ledgers", "gte", "period", "2025-02-01")).toBe(true);
  });

  it("aggregates paid/outstanding and resolves the agreement rate per venue", async () => {
    const db = mockDb(earningsFixtures());
    const rows = await computePartnerEarnings(db as never, ORG, 6, new Date("2025-07-15T00:00:00Z"));
    expect(rows).toHaveLength(3);
    const jun = rows.find((r) => r.venueId === "v1" && r.period === "2025-06")!;
    expect(jun).toMatchObject({ grossCents: 10000, commissionCents: 2000, pct: 20, paidCents: 2000, outstandingCents: 0 });
    expect(jun.payouts[0]).toMatchObject({ status: "paid", providerReference: "ACH-9" });
    const may = rows.find((r) => r.period === "2025-05")!;
    expect(may.pct).toBe(20); // venue-specific agreement applies to all its periods
    expect(may.paidCents).toBe(0);
    expect(may.outstandingCents).toBe(1800);
    const cafe = rows.find((r) => r.venueId === "v2")!;
    expect(cafe.pct).toBe(10); // falls back to org-wide agreement
    expect(cafe.outstandingCents).toBe(500); // scheduled payout is still outstanding
  });

  it("returns [] without querying venue-scoped tables when the org has no venues", async () => {
    const db = mockDb({ venues: [] });
    const rows = await computePartnerEarnings(db as never, ORG);
    expect(rows).toEqual([]);
    expect(db.calls.filter((c) => ["commission_ledgers", "payout_records", "partner_agreements"].includes(c.table))).toHaveLength(0);
  });
});

/* ─── statementCsv ──────────────────────────────────────────────────────── */

describe("statementCsv", () => {
  const base = {
    venueId: "v1", venueName: "Tavern", period: "2025-06",
    grossCents: 10000, commissionCents: 2000, pct: 20,
    paidCents: 2000, outstandingCents: 0,
    payouts: [{ id: "p1", status: "paid" as const, amountCents: 2000, method: "ach", providerReference: "ACH-9", approvedAt: null, paidAt: "2025-07-02T00:00:00Z", createdAt: "2025-06-20T00:00:00Z" }],
  };

  it("emits header + one row per payout, blank payout columns when unpaid", () => {
    const unpaid = { ...base, paidCents: 0, outstandingCents: 2000, payouts: [] };
    const csv = statementCsv([base, unpaid]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("period,venue,gross_cents,commission_cents,commission_pct,paid_cents,outstanding_cents,payout_status,payout_amount_cents,payout_method,payout_reference,payout_paid_at");
    expect(lines).toHaveLength(3); // header + paid row + unpaid row
    expect(lines[1]).toContain('"ACH-9"');
    expect(lines[2]).toContain('"","","","",""');
  });

  it("escapes commas/quotes and neutralizes formula injection", () => {
    const evil = { ...base, venueName: '=HYPERLINK("http://evil")', payouts: [] };
    const csv = statementCsv([evil]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const comma = statementCsv([{ ...base, venueName: "Cafe, Downtown", payouts: [] }]);
    expect(comma).toContain('"Cafe, Downtown"');
  });

  it("returns no_rows for empty input", () => {
    expect(statementCsv([])).toBe("no_rows\n");
  });
});

describe("status guards", () => {
  it("recognizes the widened payout status set", () => {
    for (const s of ["scheduled", "approved", "paid", "failed", "cancelled"]) expect(isPayoutStatus(s)).toBe(true);
    expect(isPayoutStatus("processing")).toBe(false);
  });
});
