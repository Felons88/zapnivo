import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Webhook/credits hardening tests: fulfillPackage flip-then-grant ordering,
 * one-time membership dedupe, stale-authorized rental expiry, 'returned'
 * terminal release, charge.refunded/dispute routing per monetization product,
 * and group pool spend at settlement. Stripe + Supabase fully mocked.
 */

const { dbState, stripeState, ops, rpcCalls } = vi.hoisted(() => ({
  dbState: { db: null as unknown },
  stripeState: {
    piMetadata: null as Record<string, string> | null,
    piOk: true,
  },
  ops: [] as string[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbState.db,
  anonClient: () => null,
  backendConfigured: () => true,
}));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: () => false,
  taxEnabled: () => false,
  stripeCall: async () => ({ ok: false, status: 0, code: "unconfigured", message: "no key" }),
  retrievePaymentIntent: async () =>
    stripeState.piOk
      ? { ok: true, data: { id: "pi_x", status: "succeeded", metadata: stripeState.piMetadata ?? {} } }
      : { ok: false, status: 500, code: "error", message: "stripe down" },
  cancelPaymentIntent: async () => ({ ok: true, data: { id: "pi", status: "canceled" } }),
}));
vi.mock("@/lib/email-monetization", () => ({
  sendMembershipActivated: vi.fn(async () => true),
  sendMembershipPaymentFailed: vi.fn(async () => true),
  sendMembershipCancelled: vi.fn(async () => true),
  sendPackagePurchased: vi.fn(async () => true),
}));
vi.mock("@/lib/email-groups", () => ({ sendGroupFunded: vi.fn(async () => true) }));
vi.mock("@/lib/email-gifts", () => ({ giftClaimLink: vi.fn(async () => true), giftRedeemedConfirmation: vi.fn(async () => true) }));
vi.mock("@/lib/gifts-delivery", () => ({
  CLAIM_TOKEN_TTL_HOURS: 72,
  claimGiftUrl: (t: string) => `http://x/claim?token=${t}`,
  generateClaimToken: () => "tok",
  hashClaimToken: (t: string) => `hash:${t}`,
}));

import { handleMonetizationEvent, handleMonetizationRefund, handleMonetizationDispute } from "@/lib/monetization/webhook";
import { applyCreditsAtSettlement, expireStaleAuthorizedRentals, releaseOrphanedReservations } from "@/lib/monetization/credits";
import { PRICING_V1, type PricingVersion } from "@/lib/pricing";

type Row = Record<string, any>;

/** Eq/lt/in-aware thenable fake with op ordering log + RPC mirrors of the SQL functions. */
function fakeDb(seed: Record<string, Row[]> = {}, opts: { failGrantRpc?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    package_purchases: [], prepaid_packages: [], profiles: [], customer_memberships: [],
    entitlement_grants: [], entitlement_events: [], entitlement_reservations: [],
    gift_credits: [], group_credit_purchases: [], rental_groups: [], rental_group_members: [],
    event_passes: [], membership_plans: [], rentals: [], payments: [],
    app_logs: [], audit_logs: [], stripe_events: [],
    ...seed,
  };
  let seq = 0;
  const genId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const db = {
    rpc: async (fn: string, args: Row) => {
      ops.push(`rpc:${fn}`);
      rpcCalls.push({ fn, args });
      if (fn === "grant_entitlement") {
        if (opts.failGrantRpc) return { data: null, error: { message: "grant failed" } };
        return { data: `grant-${seq}`, error: null };
      }
      if (fn === "release_rental_reservations") {
        const n = (tables.entitlement_reservations ?? []).filter((r) => r.rental_id === args.p_rental_id && r.status === "reserved").length;
        for (const r of tables.entitlement_reservations ?? []) if (r.rental_id === args.p_rental_id && r.status === "reserved") r.status = "released";
        return { data: n, error: null };
      }
      if (fn === "adjust_group_credit") {
        const g = tables.rental_groups.find((r) => r.id === args.p_group);
        if (!g) return { data: null, error: { message: "group_not_found" } };
        const next = (g.credit_cents ?? 0) + (args.p_delta as number);
        if (next < 0) return { data: null, error: { message: "negative_balance" } };
        g.credit_cents = next;
        return { data: next, error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      const t = (tables[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      let pickCols: string[] | null = null;
      const sorts: { col: string; asc: boolean }[] = [];
      let lim = Infinity;
      const matched = () => t.filter((r) => filters.every((f) => f(r)));
      const ordered = () => {
        let l = matched();
        for (const s of [...sorts].reverse()) {
          l = [...l].sort((a, b) => {
            const av = a[s.col], bv = b[s.col];
            const c = av == null ? -1 : bv == null ? 1 : av < bv ? -1 : av > bv ? 1 : 0;
            return s.asc ? c : -c;
          });
        }
        return l.slice(0, lim);
      };
      const project = (rows: Row[]) =>
        pickCols ? rows.map((r) => Object.fromEntries(pickCols!.map((c) => [c, r[c]]))) : rows;
      const run = async () => {
        if (op === "insert" && payload) {
          ops.push(`insert:${table}`);
          const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const ins = items.map((p) => ({ id: p.id ?? genId(), created_at: p.created_at ?? "2026-02-01T00:00:00Z", ...p }));
          t.push(...ins);
          return { data: project(ins), error: null };
        }
        if (op === "update" && payload) {
          ops.push(`update:${table}`);
          const hit = matched();
          hit.forEach((r) => Object.assign(r, payload as Row));
          return { data: project(hit), error: null };
        }
        return { data: project(ordered()), error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = (cols?: string) => {
        pickCols = typeof cols === "string" && cols.trim() ? cols.split(",").map((c) => c.trim()).filter(Boolean) : null;
        return q;
      };
      q.insert = (p: Row | Row[]) => { op = "insert"; payload = p; return q; };
      q.update = (p: Row) => { op = "update"; payload = p; return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v || (v === null && (r[col] === null || r[col] === undefined))); return q; };
      q.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; };
      q.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; };
      q.is = (col: string, v: unknown) => { filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return q; };
      q.not = (col: string, op: string, v: unknown) => {
        if (op === "is" && v === null) filters.push((r) => r[col] !== null && r[col] !== undefined);
        else filters.push((r) => r[col] !== v);
        return q;
      };
      q.lt = (col: string, v: unknown) => { filters.push((r) => r[col] != null && String(r[col]) < String(v)); return q; };
      q.order = (col: string, o?: { ascending?: boolean }) => { sorts.push({ col, asc: o?.ascending !== false }); return q; };
      q.limit = (n: number) => { lim = n; return q; };
      q.single = async () => {
        const r = await run();
        const d = Array.isArray(r.data) ? r.data[0] ?? null : (r.data as Row | null);
        return { data: d, error: d ? null : { message: "not found", code: "PGRST116" } };
      };
      q.maybeSingle = async () => {
        const r = await run();
        const d = Array.isArray(r.data) ? r.data[0] ?? null : (r.data as Row | null);
        return { data: d, error: null };
      };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
      return q;
    },
  };
  return { db: db as never, tables };
}

const PROFILE = "11111111-1111-4111-8111-111111111111";
const pricing: PricingVersion = { ...PRICING_V1, approved: true, additionalDayCents: 1677 };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeEach(() => {
  ops.length = 0;
  rpcCalls.length = 0;
  stripeState.piMetadata = null;
  stripeState.piOk = true;
});

/* ── fulfillPackage: flip-then-grant ─────────────────────────────────────── */

describe("fulfillPackage ordering", () => {
  const seed = () => ({
    package_purchases: [{ id: "pp1", profile_id: PROFILE, package_id: "pkg1", status: "pending", amount_cents: 1000, created_at: "2026-02-01T00:00:00Z" }],
    prepaid_packages: [{ id: "pkg1", name: "Power Pack", kind: "cent", units: 500, validity_days: null, active: true }],
    profiles: [{ id: PROFILE, email: "p@example.com" }],
  });
  const evt = () => ({
    type: "checkout.session.completed",
    data: { object: { id: "cs_pkg", payment_intent: "pi_pkg", metadata: { kind: "package", purchase_id: "pp1", profile_id: PROFILE } } },
  });

  it("flips pending→paid BEFORE granting, and a replay does not re-grant", async () => {
    const f = fakeDb(seed());
    dbState.db = f.db;
    await handleMonetizationEvent(f.db, evt());
    expect(f.tables.package_purchases[0].status).toBe("paid");
    expect(f.tables.package_purchases[0].stripe_payment_intent_id).toBe("pi_pkg");
    const grants = rpcCalls.filter((c) => c.fn === "grant_entitlement");
    expect(grants).toHaveLength(1);
    expect(grants[0].args).toMatchObject({ p_unit: "cent", p_amount: 500, p_source_type: "package_purchase", p_source_id: "pp1" });
    // Ordering: the guarded status flip must precede the grant RPC.
    const flipIdx = ops.indexOf("update:package_purchases");
    const grantIdx = ops.indexOf("rpc:grant_entitlement");
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(grantIdx).toBeGreaterThan(flipIdx);

    // Webhook replay: status already paid → no second grant.
    await handleMonetizationEvent(f.db, evt());
    expect(rpcCalls.filter((c) => c.fn === "grant_entitlement")).toHaveLength(1);
  });

  it("leaves the purchase paid but ungranted (flagged) when grant fails after the flip", async () => {
    const f = fakeDb(seed(), { failGrantRpc: true });
    dbState.db = f.db;
    await handleMonetizationEvent(f.db, evt());
    expect(f.tables.package_purchases[0].status).toBe("paid"); // never re-grant on replay
    await handleMonetizationEvent(f.db, evt());
    expect(rpcCalls.filter((c) => c.fn === "grant_entitlement")).toHaveLength(1);
  });
});

/* ── activateOneTimeMembership ────────────────────────────────────────────── */

describe("activateOneTimeMembership", () => {
  const seed = () => ({
    membership_plans: [{ id: "plan1", name: "Pro", interval: "month", benefit: { credit_cents: 500 }, active: true }],
    profiles: [{ id: PROFILE, email: "p@example.com" }],
  });
  const evt = (sessionId: string) => ({
    type: "checkout.session.completed",
    data: { object: { id: sessionId, payment_intent: `pi_${sessionId}`, metadata: { kind: "membership", plan_id: "plan1", profile_id: PROFILE } } },
  });

  it("activates once; a second checkout session for the same plan is a no-op", async () => {
    const f = fakeDb(seed());
    dbState.db = f.db;
    await handleMonetizationEvent(f.db, evt("cs_m1"));
    await handleMonetizationEvent(f.db, evt("cs_m2"));
    expect(f.tables.customer_memberships).toHaveLength(1);
    expect(f.tables.customer_memberships[0].status).toBe("active");
    expect(rpcCalls.filter((c) => c.fn === "grant_entitlement")).toHaveLength(1);
  });
});

/* ── stale authorized / returned reservation sweeps ───────────────────────── */

describe("expireStaleAuthorizedRentals", () => {
  it("cancels authorized rentals >2h old, releases reservations, fails payments", async () => {
    const f = fakeDb({
      rentals: [
        { id: "r-old", state: "authorized", created_at: hoursAgo(3) },
        { id: "r-fresh", state: "authorized", created_at: hoursAgo(0.5) },
        { id: "r-disp", state: "dispense_pending", created_at: hoursAgo(30) },
      ],
      payments: [{ id: "pay1", rental_id: "r-old", state: "authorized", stripe_payment_intent_id: null }],
      entitlement_reservations: [
        { id: "res1", rental_id: "r-old", profile_id: PROFILE, grant_id: "g1", unit: "cent", amount: 100, status: "reserved" },
        { id: "res2", rental_id: "r-disp", profile_id: PROFILE, grant_id: "g2", unit: "cent", amount: 100, status: "reserved" },
      ],
    });
    const out = await expireStaleAuthorizedRentals(f.db);
    expect(out.cancelled).toBe(1);
    expect(f.tables.rentals.find((r) => r.id === "r-old")?.state).toBe("cancelled");
    expect(f.tables.rentals.find((r) => r.id === "r-fresh")?.state).toBe("authorized");
    // dispense_pending stays open for staff, but its reservation is released.
    expect(f.tables.rentals.find((r) => r.id === "r-disp")?.state).toBe("dispense_pending");
    const pay = f.tables.payments[0];
    expect(pay.state).toBe("failed");
    expect(pay.failure_code).toBe("checkout_abandoned");
    expect(rpcCalls.filter((c) => c.fn === "release_rental_reservations").map((c) => c.args.p_rental_id).sort()).toEqual(["r-disp", "r-old"]);
    // Idempotent second run.
    const again = await expireStaleAuthorizedRentals(f.db);
    expect(again.cancelled).toBe(0);
  });
});

describe("releaseOrphanedReservations terminal states", () => {
  it("releases reservations for 'returned' rentals (capture-failed orphans)", async () => {
    const f = fakeDb({
      rentals: [{ id: "r-ret", state: "returned", created_at: hoursAgo(1) }],
      entitlement_reservations: [{ id: "res1", rental_id: "r-ret", profile_id: PROFILE, grant_id: "g1", unit: "cent", amount: 50, status: "reserved" }],
    });
    const n = await releaseOrphanedReservations(f.db);
    expect(n).toBe(1);
    expect(f.tables.entitlement_reservations[0].status).toBe("released");
  });
});

/* ── charge.refunded / dispute routing ────────────────────────────────────── */

const fullRefund = (pi: string) => ({ payment_intent: pi, amount: 2000, amount_captured: 2000, amount_refunded: 2000 });

describe("handleMonetizationRefund", () => {
  it("gift: flips paid→refunded and revokes the cent grant", async () => {
    const f = fakeDb({
      gift_credits: [{ id: "g1", status: "paid", stripe_payment_intent_id: "pi_g" }],
      entitlement_grants: [{ id: "gr1", profile_id: PROFILE, source_type: "gift_credit", source_id: "g1", status: "active", remaining: 500 }],
    });
    expect(await handleMonetizationRefund(f.db, fullRefund("pi_g"))).toBe(true);
    expect(f.tables.gift_credits[0].status).toBe("refunded");
    expect(f.tables.gift_credits[0].refunded_at).toBeTruthy();
    expect(f.tables.entitlement_grants[0]).toMatchObject({ status: "revoked", remaining: 0 });
    expect(f.tables.entitlement_events.some((e) => e.event === "refund" && e.grant_id === "gr1")).toBe(true);
    // Idempotent replay.
    await handleMonetizationRefund(f.db, fullRefund("pi_g"));
    expect(f.tables.entitlement_events.filter((e) => e.event === "refund")).toHaveLength(1);
  });

  it("package: flips paid→refunded and revokes package grants", async () => {
    const f = fakeDb({
      package_purchases: [{ id: "pp1", status: "paid", stripe_payment_intent_id: "pi_p", profile_id: PROFILE }],
      entitlement_grants: [{ id: "gr1", profile_id: PROFILE, source_type: "package_purchase", source_id: "pp1", status: "active", remaining: 300 }],
    });
    expect(await handleMonetizationRefund(f.db, fullRefund("pi_p"))).toBe(true);
    expect(f.tables.package_purchases[0].status).toBe("refunded");
    expect(f.tables.entitlement_grants[0].status).toBe("revoked");
  });

  it("group funding: flips refunded and decrements the pool via RPC", async () => {
    const f = fakeDb({
      group_credit_purchases: [{ id: "gp1", group_id: "grp1", amount_cents: 2500, status: "paid", stripe_payment_intent_id: "pi_gp" }],
      rental_groups: [{ id: "grp1", organizer_id: PROFILE, credit_cents: 5000, status: "active" }],
    });
    expect(await handleMonetizationRefund(f.db, fullRefund("pi_gp"))).toBe(true);
    expect(f.tables.group_credit_purchases[0].status).toBe("refunded");
    expect(f.tables.rental_groups[0].credit_cents).toBe(2500);
    expect(rpcCalls).toContainEqual(expect.objectContaining({ fn: "adjust_group_credit", args: expect.objectContaining({ p_delta: -2500 }) }));
  });

  it("event pass: resolves via PI metadata and revokes an unpaid-active pass", async () => {
    stripeState.piMetadata = { kind: "event_pass", pass_id: "ep1" };
    const f = fakeDb({ event_passes: [{ id: "ep1", status: "active", holder_id: null }] });
    expect(await handleMonetizationRefund(f.db, fullRefund("pi_ep"))).toBe(true);
    expect(f.tables.event_passes[0].status).toBe("revoked");
  });

  it("returns false for non-monetization PIs and logs-only for partial refunds", async () => {
    const f = fakeDb({});
    expect(await handleMonetizationRefund(f.db, fullRefund("pi_unknown"))).toBe(false);
    const g = fakeDb({ gift_credits: [{ id: "g1", status: "paid", stripe_payment_intent_id: "pi_g" }] });
    const partial = { payment_intent: "pi_g", amount: 2000, amount_captured: 2000, amount_refunded: 500 };
    expect(await handleMonetizationRefund(g.db, partial)).toBe(true);
    expect(g.tables.gift_credits[0].status).toBe("paid"); // partial → no flip
  });
});

describe("handleMonetizationDispute", () => {
  it("audits a monetization dispute without mutating state", async () => {
    const f = fakeDb({ gift_credits: [{ id: "g1", status: "paid", stripe_payment_intent_id: "pi_g" }] });
    dbState.db = f.db; // auditLog/recordLog resolve the client via serviceClient()
    const handled = await handleMonetizationDispute(f.db, { id: "dp_1", payment_intent: "pi_g", amount: 2000, reason: "fraudulent", status: "needs_response" });
    expect(handled).toBe(true);
    expect(f.tables.gift_credits[0].status).toBe("paid"); // no auto action
    expect(f.tables.audit_logs.length).toBeGreaterThan(0);
  });

  it("returns false for unrelated payment intents", async () => {
    const f = fakeDb({});
    dbState.db = f.db;
    expect(await handleMonetizationDispute(f.db, { id: "dp_2", payment_intent: "pi_rental", amount: 100 })).toBe(false);
  });
});

/* ── group pool spend at settlement ───────────────────────────────────────── */

describe("group pool spend", () => {
  const memberSeed = (pool = 500) => ({
    rental_group_members: [{ id: "m1", group_id: "grp1", profile_id: PROFILE, status: "active", created_at: "2026-01-01T00:00:00Z" }],
    rental_groups: [{ id: "grp1", organizer_id: "org1", credit_cents: pool, status: "active", created_at: "2026-01-01T00:00:00Z" }],
    entitlement_reservations: [{ id: "rc", grant_id: "g1", rental_id: "r1", profile_id: PROFILE, unit: "cent", amount: 200, status: "reserved" }],
  });

  it("covers the uncovered remainder from the member's funded group pool", async () => {
    const f = fakeDb(memberSeed(500));
    // $10 charge; 200¢ personal cent reservation commits → 800¢ leftover → pool covers 500.
    const applied = await applyCreditsAtSettlement(f.db, "r1", PROFILE, 1000, pricing, "staff:test");
    expect(applied).toBe(700);
    expect(rpcCalls).toContainEqual(expect.objectContaining({
      fn: "adjust_group_credit",
      args: expect.objectContaining({ p_group: "grp1", p_delta: -500, p_actor: "system:group_pool_spend" }),
    }));
    expect(f.tables.rental_groups[0].credit_cents).toBe(0);
  });

  it("spends nothing when personal credits cover the charge or no funded group exists", async () => {
    const covered = fakeDb({
      ...memberSeed(500),
      entitlement_reservations: [{ id: "rr", grant_id: "g9", rental_id: "r1", profile_id: PROFILE, unit: "rental", amount: 1, status: "reserved" }],
    });
    // commit_entitlement_partial isn't modeled — rental unit commit returns data null, error null → counts.
    const a1 = await applyCreditsAtSettlement(covered.db, "r1", PROFILE, 1000, pricing, "staff:test");
    expect(a1).toBe(1000);
    expect(rpcCalls.filter((c) => c.fn === "adjust_group_credit")).toHaveLength(0);

    rpcCalls.length = 0;
    const noGroup = fakeDb({ entitlement_reservations: [{ id: "rc", grant_id: "g1", rental_id: "r1", profile_id: PROFILE, unit: "cent", amount: 200, status: "reserved" }] });
    const a2 = await applyCreditsAtSettlement(noGroup.db, "r1", PROFILE, 1000, pricing, "staff:test");
    expect(a2).toBe(200);
    expect(rpcCalls.filter((c) => c.fn === "adjust_group_credit")).toHaveLength(0);
  });
});
