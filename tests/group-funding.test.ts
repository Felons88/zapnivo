import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Group self-serve credit funding tests. Stripe + Supabase are fully mocked;
 * the fake DB is an eq-aware thenable query builder so organizer isolation,
 * purchase-before-checkout ordering and webhook idempotency are all asserted.
 */

const { session, dbState, stripeState, events, rpcCalls } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbState: { db: null as unknown },
  stripeState: {
    configured: true,
    result: { ok: true as const, data: { id: "cs_test_gf", url: "https://checkout.stripe.com/c/pay/cs_test_gf" } } as
      { ok: true; data: { id: string; url: string } } | { ok: false; status: number; code: string; message: string },
    lastBody: null as Record<string, unknown> | null,
  },
  events: [] as string[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => session.user,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbState.db,
  anonClient: () => null,
  backendConfigured: () => true,
}));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: () => stripeState.configured,
  stripeCall: (method: string, path: string, body?: Record<string, unknown>) => {
    events.push(`stripe:${method} ${path}`);
    stripeState.lastBody = body ?? null;
    return Promise.resolve(stripeState.result);
  },
  taxEnabled: () => false,
  PAYMENTS_UNCONFIGURED: { error: "Payments are not available yet.", code: "payments_unconfigured" },
}));
vi.mock("@/lib/email-groups", () => ({ sendGroupFunded: vi.fn(async () => true) }));
vi.mock("@/lib/email-monetization", () => ({
  sendMembershipActivated: vi.fn(async () => true),
  sendMembershipPaymentFailed: vi.fn(async () => true),
  sendMembershipCancelled: vi.fn(async () => true),
  sendPackagePurchased: vi.fn(async () => true),
}));

import { resetRateLimits } from "@/lib/rate-limit";
import { sendGroupFunded } from "@/lib/email-groups";
import { handleMonetizationEvent } from "@/lib/monetization/webhook";

/* ── eq-aware fake supabase ────────────────────────────────────────────────── */

type Row = Record<string, any>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    rental_groups: [], rental_group_members: [], group_credit_purchases: [],
    profiles: [], entitlement_events: [], audit_logs: [],
    ...seed,
  };
  let seq = 0;
  const genId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const db = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === "fund_group_credit") {
        // Mirror migration 0034: lock purchase, pending-guard, flip paid,
        // increment pool, write entitlement_events audit.
        const p = tables.group_credit_purchases.find((r) => r.id === args.p_purchase_id);
        if (!p || p.status !== "pending") return { data: false, error: null };
        p.status = "paid";
        p.paid_at = "2026-02-01T00:00:00Z";
        const g = tables.rental_groups.find((r) => r.id === p.group_id);
        if (g) {
          g.credit_cents = (g.credit_cents ?? 0) + p.amount_cents;
          tables.entitlement_events.push({
            grant_id: null, profile_id: p.organizer_id, event: "grant",
            delta: p.amount_cents, balance_after: g.credit_cents,
            ref_type: "group_credit", ref_id: p.group_id, actor: "webhook",
          });
        }
        return { data: true, error: null };
      }
      if (fn === "adjust_group_credit") {
        const g = tables.rental_groups.find((r) => r.id === args.p_group);
        if (!g) return { data: null, error: { message: "group_not_found" } };
        const next = (g.credit_cents ?? 0) + args.p_delta;
        if (next < 0) return { data: null, error: { message: "negative_balance" } };
        g.credit_cents = next;
        tables.entitlement_events.push({
          grant_id: null, profile_id: g.organizer_id, event: "adjust",
          delta: args.p_delta, balance_after: next,
          ref_type: "group_credit", ref_id: args.p_group, actor: args.p_actor,
        });
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
      const run = async () => {
        if (op === "insert" && payload) {
          const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const ins = items.map((p) => ({ id: p.id ?? genId(), created_at: "2026-02-01T00:00:00Z", ...p }));
          t.push(...ins);
          return { data: ins, error: null };
        }
        if (op === "update" && payload) {
          const hit = matched();
          hit.forEach((r) => Object.assign(r, payload as Row));
          return { data: hit, error: null };
        }
        const rows = ordered().map((r) =>
          pickCols ? Object.fromEntries(pickCols.map((c) => [c, r[c]])) : r,
        );
        return { data: rows, error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = (cols?: string) => {
        // Top-level column projection (no embedded selects in these routes).
        pickCols = typeof cols === "string" && cols.trim() ? cols.split(",").map((c) => c.trim()).filter(Boolean) : null;
        return q;
      };
      q.insert = (p: Row | Row[]) => { op = "insert"; payload = p; events.push(`db:insert:${table}`); return q; };
      q.update = (p: Row) => { op = "update"; payload = p; events.push(`db:update:${table}`); return q; };
      q.delete = () => { op = "delete"; return q; };
      q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v || (v === null && (r[col] === null || r[col] === undefined))); return q; };
      q.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return q; };
      q.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q; };
      q.is = (col: string, v: unknown) => { filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v)); return q; };
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

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizer_id: ORG, name: "Friday Crew", max_members: 10, credit_cents: 1000, status: "active",
};

const seedGroup = (over: Row = {}) => ({
  rental_groups: [{ ...GROUP, ...over }],
  profiles: [{ id: ORG, email: "organizer@example.com", role: "customer" }],
});

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const checkoutEvent = (purchaseId: string, pi = "pi_gf_1") => ({
  type: "checkout.session.completed",
  data: { object: { id: "cs_gf_1", payment_intent: pi, metadata: { kind: "group_funding", purchase_id: purchaseId, group_id: GROUP.id } } },
});

beforeEach(() => {
  session.user = { id: ORG, email: "organizer@example.com", role: "customer", organizationId: null };
  stripeState.configured = true;
  stripeState.result = { ok: true, data: { id: "cs_test_gf", url: "https://checkout.stripe.com/c/pay/cs_test_gf" } };
  stripeState.lastBody = null;
  events.length = 0;
  rpcCalls.length = 0;
  dbState.db = fakeDb(seedGroup()).db;
  resetRateLimits();
  vi.mocked(sendGroupFunded).mockClear();
});

/* ── POST /api/groups/[id]/fund ────────────────────────────────────────────── */

describe("POST /api/groups/[id]/fund", () => {
  it("401 when signed out", async () => {
    session.user = null;
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await POST(post(`/api/groups/${GROUP.id}/fund`, { amountCents: 2500 }), params(GROUP.id));
    expect(res.status).toBe(401);
  });

  it("404 for a non-organizer even when the group exists", async () => {
    session.user = { id: OTHER, email: "other@example.com", role: "customer", organizationId: null };
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await POST(post(`/api/groups/${GROUP.id}/fund`, { amountCents: 2500 }), params(GROUP.id));
    expect(res.status).toBe(404);
    expect(events.some((e) => e === "db:insert:group_credit_purchases")).toBe(false);
    expect(events.some((e) => e.startsWith("stripe:"))).toBe(false);
  });

  it("404 for an unknown group", async () => {
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await POST(post("/api/groups/does-not-exist/fund", { amountCents: 2500 }), params("does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("422 below the $5 minimum and above the $500 maximum", async () => {
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    for (const amountCents of [0, 499, 50000 + 1, 1.5, "2500"]) {
      const res = await POST(post(`/api/groups/${GROUP.id}/fund`, { amountCents }), params(GROUP.id));
      expect(res.status).toBe(422);
    }
    expect(events.some((e) => e === "db:insert:group_credit_purchases")).toBe(false);
  });

  it("503 payments_unconfigured without a Stripe key", async () => {
    stripeState.configured = false;
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await POST(post(`/api/groups/${GROUP.id}/fund`, { amountCents: 2500 }), params(GROUP.id));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unconfigured");
    expect(events.some((e) => e === "db:insert:group_credit_purchases")).toBe(false);
  });

  it("creates the group_credit_purchases row BEFORE calling Stripe, then returns the URL", async () => {
    const { POST } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await POST(post(`/api/groups/${GROUP.id}/fund`, { amountCents: 2500 }), params(GROUP.id));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("checkout.stripe.com");
    const insIdx = events.indexOf("db:insert:group_credit_purchases");
    const stripeIdx = events.findIndex((e) => e.startsWith("stripe:"));
    expect(insIdx).toBeGreaterThanOrEqual(0);
    expect(stripeIdx).toBeGreaterThan(insIdx);
    expect(events).toContain("db:update:group_credit_purchases"); // session id stored

    // Checkout metadata routes the webhook; the purchase row carries the truth.
    const body = stripeState.lastBody as { metadata?: Record<string, string>; line_items?: { price_data?: { unit_amount?: number } }[] };
    expect(body.metadata?.kind).toBe("group_funding");
    expect(body.metadata?.group_id).toBe(GROUP.id);
    expect(body.line_items?.[0]?.price_data?.unit_amount).toBe(2500);
    // The organizer never writes credit_cents — only the RPC does (webhook path).
    expect(events.some((e) => e === "db:update:rental_groups")).toBe(false);
  });
});

/* ── GET /api/groups/[id]/fund ─────────────────────────────────────────────── */

describe("GET /api/groups/[id]/fund", () => {
  it("401 when signed out", async () => {
    session.user = null;
    const { GET } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await GET(new Request("http://localhost/api/groups/x/fund"), params(GROUP.id));
    expect(res.status).toBe(401);
  });

  it("404 for a non-organizer", async () => {
    session.user = { id: OTHER, email: "other@example.com", role: "customer", organizationId: null };
    const { GET } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await GET(new Request("http://localhost/api/groups/x/fund"), params(GROUP.id));
    expect(res.status).toBe(404);
  });

  it("returns the organizer's purchase history (status/amount/paid_at, no stripe ids)", async () => {
    dbState.db = fakeDb({
      ...seedGroup(),
      group_credit_purchases: [
        { id: "pur-1", group_id: GROUP.id, organizer_id: ORG, amount_cents: 2500, status: "paid", paid_at: "2026-02-01T00:00:00Z", stripe_payment_intent_id: "pi_secret", created_at: "2026-02-01T00:00:00Z" },
        { id: "pur-2", group_id: GROUP.id, organizer_id: OTHER, amount_cents: 9999, status: "pending", paid_at: null, created_at: "2026-02-01T00:00:00Z" },
      ],
    }).db;
    const { GET } = await import("../src/app/api/groups/[id]/fund/route");
    const res = await GET(new Request("http://localhost/api/groups/x/fund"), params(GROUP.id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.purchases).toHaveLength(1);
    expect(json.purchases[0]).toMatchObject({ id: "pur-1", amount_cents: 2500, status: "paid" });
    expect(JSON.stringify(json)).not.toContain("pi_secret");
  });
});

/* ── webhook group_funding ─────────────────────────────────────────────────── */

describe("webhook group_funding", () => {
  const seedPurchase = (over: Row = {}) => ({
    id: "pur-webhook-1", group_id: GROUP.id, organizer_id: ORG,
    amount_cents: 2500, status: "pending", paid_at: null, created_at: "2026-02-01T00:00:00Z", ...over,
  });

  it("calls fund_group_credit with p_purchase_id and tops up the pool once", async () => {
    const f = fakeDb({ ...seedGroup(), group_credit_purchases: [seedPurchase()] });
    dbState.db = f.db;
    const handled = await handleMonetizationEvent(f.db, checkoutEvent("pur-webhook-1"));
    expect(handled).toBe(true);
    expect(rpcCalls).toEqual([{ fn: "fund_group_credit", args: { p_purchase_id: "pur-webhook-1" } }]);
    expect(f.tables.rental_groups[0].credit_cents).toBe(3500); // 1000 + 2500
    expect(f.tables.entitlement_events).toHaveLength(1);
    expect(f.tables.entitlement_events[0]).toMatchObject({ event: "grant", delta: 2500, ref_type: "group_credit" });
    expect(f.tables.group_credit_purchases[0].status).toBe("paid");
    expect(f.tables.group_credit_purchases[0].stripe_payment_intent_id).toBe("pi_gf_1");
    expect(vi.mocked(sendGroupFunded)).toHaveBeenCalledWith(
      expect.objectContaining({ email: "organizer@example.com", groupName: "Friday Crew", amountCents: 2500, groupId: GROUP.id }),
    );
  });

  it("is idempotent — a replayed webhook is a no-op but still handled (200 upstream)", async () => {
    const f = fakeDb({ ...seedGroup(), group_credit_purchases: [seedPurchase()] });
    dbState.db = f.db;
    await handleMonetizationEvent(f.db, checkoutEvent("pur-webhook-1"));
    const second = await handleMonetizationEvent(f.db, checkoutEvent("pur-webhook-1", "pi_gf_1b"));
    expect(second).toBe(true);
    expect(rpcCalls).toHaveLength(2); // RPC called again; returns false internally for non-pending
    expect(f.tables.rental_groups[0].credit_cents).toBe(3500); // topped up exactly once
    expect(f.tables.entitlement_events).toHaveLength(1);
    expect(vi.mocked(sendGroupFunded)).toHaveBeenCalledTimes(1);
  });

  it("never double-funds a refunded purchase — RPC returns false", async () => {
    const f = fakeDb({ ...seedGroup(), group_credit_purchases: [seedPurchase({ status: "refunded" })] });
    dbState.db = f.db;
    const handled = await handleMonetizationEvent(f.db, checkoutEvent("pur-webhook-1"));
    expect(handled).toBe(true);
    expect(rpcCalls).toEqual([{ fn: "fund_group_credit", args: { p_purchase_id: "pur-webhook-1" } }]);
    expect(f.tables.rental_groups[0].credit_cents).toBe(1000);
    expect(f.tables.entitlement_events).toHaveLength(0);
    expect(vi.mocked(sendGroupFunded)).not.toHaveBeenCalled();
  });

  it("ignores events without a purchase_id", async () => {
    const f = fakeDb(seedGroup());
    dbState.db = f.db;
    const handled = await handleMonetizationEvent(f.db, {
      type: "checkout.session.completed",
      data: { object: { id: "cs_x", metadata: { kind: "group_funding" } } },
    });
    expect(handled).toBe(true);
    expect(rpcCalls).toHaveLength(0);
  });
});
