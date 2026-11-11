import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Monetization checkout/benefits route tests. Stripe + Supabase are fully mocked;
 * the fake DB is a minimal thenable query builder that records inserts/updates
 * so we can assert ordering (purchase row BEFORE the Stripe call).
 */

const { session, dbState, stripeState, events } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbState: { db: null as unknown, tables: {} as Record<string, Record<string, unknown>[]> },
  stripeState: { configured: true, result: { ok: true as const, data: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } } as { ok: true; data: { id: string; url: string } } | { ok: false; status: number; code: string; message: string } },
  events: [] as string[],
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
  stripeCall: (method: string, path: string) => {
    events.push(`stripe:${method} ${path}`);
    return Promise.resolve(stripeState.result);
  },
  taxEnabled: () => false,
  PAYMENTS_UNCONFIGURED: { error: "Payments are not available yet.", code: "payments_unconfigured" },
}));
vi.mock("@/lib/email-monetization", () => ({
  sendMembershipActivated: vi.fn(async () => true),
  sendMembershipPaymentFailed: vi.fn(async () => true),
  sendMembershipCancelled: vi.fn(async () => true),
  sendPackagePurchased: vi.fn(async () => true),
}));

import { resetRateLimits } from "@/lib/rate-limit";

/* ── Minimal Supabase-ish fake ─────────────────────────────────────────────── */

function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  dbState.tables = tables;
  const rows = (t: string) => dbState.tables[t] ?? [];
  return {
    from(table: string) {
      const state = { mode: "select" as "select" | "insert" | "update", inserted: null as Record<string, unknown> | null };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit", "ilike", "is", "or", "neq", "gte", "lte", "delete", "upsert"]) {
        q[m] = () => q;
      }
      q.insert = (row: Record<string, unknown>) => { state.mode = "insert"; state.inserted = row; events.push(`db:insert:${table}`); return q; };
      q.update = () => { state.mode = "update"; events.push(`db:update:${table}`); return q; };
      q.maybeSingle = async () => ({
        data: state.mode === "insert" ? { id: `${table}-new-1`, ...(state.inserted ?? {}) } : (rows(table)[0] ?? null),
        error: null,
      });
      q.single = async () => ({
        data: state.mode === "insert" ? { id: `${table}-new-1`, ...(state.inserted ?? {}) } : (rows(table)[0] ?? null),
        error: null,
      });
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: state.mode === "insert" ? [] : rows(table), error: null }).then(res, rej);
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const CUSTOMER = { id: "user-1", email: "c@example.com", role: "customer", organizationId: null };
const PLAN = { id: "plan-month", name: "Monthly Charge", price_cents: 999, interval: "month", benefit: { rental_minutes: 120 }, active: true };
const PKG = { id: "pkg-10", name: "10 rentals", kind: "rental", units: 10, price_cents: 4900, validity_days: 90, active: true };

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  session.user = { ...CUSTOMER };
  stripeState.configured = true;
  stripeState.result = { ok: true, data: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } };
  events.length = 0;
  dbState.db = fakeDb({});
  resetRateLimits();
});

describe("POST /api/monetization/membership/checkout", () => {
  it("401 when signed out", async () => {
    session.user = null;
    const { POST } = await import("../src/app/api/monetization/membership/checkout/route");
    const res = await POST(post("/api/monetization/membership/checkout", { planId: "plan-month" }));
    expect(res.status).toBe(401);
  });

  it("422 when the plan is inactive", async () => {
    dbState.db = fakeDb({ membership_plans: [{ ...PLAN, active: false }] });
    const { POST } = await import("../src/app/api/monetization/membership/checkout/route");
    const res = await POST(post("/api/monetization/membership/checkout", { planId: "plan-month" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("plan_inactive");
    expect(events.some((e) => e.startsWith("stripe:"))).toBe(false);
  });

  it("404 when the plan doesn't exist", async () => {
    const { POST } = await import("../src/app/api/monetization/membership/checkout/route");
    const res = await POST(post("/api/monetization/membership/checkout", { planId: "nope" }));
    expect(res.status).toBe(404);
  });

  it("503 payments_unconfigured without a Stripe key", async () => {
    stripeState.configured = false;
    const { POST } = await import("../src/app/api/monetization/membership/checkout/route");
    const res = await POST(post("/api/monetization/membership/checkout", { planId: "plan-month" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unconfigured");
  });

  it("returns the Stripe URL for a recurring plan (month → subscription checkout)", async () => {
    dbState.db = fakeDb({ membership_plans: [PLAN] });
    const { POST } = await import("../src/app/api/monetization/membership/checkout/route");
    const res = await POST(post("/api/monetization/membership/checkout", { planId: "plan-month" }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("checkout.stripe.com");
    expect(events).toContain("stripe:POST /checkout/sessions");
  });
});

describe("POST /api/monetization/package/checkout", () => {
  it("creates the package_purchases row BEFORE calling Stripe", async () => {
    dbState.db = fakeDb({ prepaid_packages: [PKG] });
    const { POST } = await import("../src/app/api/monetization/package/checkout/route");
    const res = await POST(post("/api/monetization/package/checkout", { packageId: "pkg-10" }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("checkout.stripe.com");
    const insIdx = events.indexOf("db:insert:package_purchases");
    const stripeIdx = events.findIndex((e) => e.startsWith("stripe:"));
    expect(insIdx).toBeGreaterThanOrEqual(0);
    expect(stripeIdx).toBeGreaterThan(insIdx);
    expect(events).toContain("db:update:package_purchases"); // session id stored
  });

  it("503 payments_unconfigured without a Stripe key", async () => {
    stripeState.configured = false;
    const { POST } = await import("../src/app/api/monetization/package/checkout/route");
    const res = await POST(post("/api/monetization/package/checkout", { packageId: "pkg-10" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("payments_unconfigured");
    expect(events.some((e) => e === "db:insert:package_purchases")).toBe(false);
  });

  it("422 when the package is inactive", async () => {
    dbState.db = fakeDb({ prepaid_packages: [{ ...PKG, active: false }] });
    const { POST } = await import("../src/app/api/monetization/package/checkout/route");
    const res = await POST(post("/api/monetization/package/checkout", { packageId: "pkg-10" }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("package_inactive");
  });
});

describe("GET /api/monetization/benefits", () => {
  it("401 when signed out", async () => {
    session.user = null;
    const { GET } = await import("../src/app/api/monetization/benefits/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the entitlement snapshot shape", async () => {
    dbState.db = fakeDb({
      entitlement_grants: [{ id: "g1", profile_id: "user-1", kind: "prepaid", unit: "rental", granted: 10, remaining: 7, expires_at: null, status: "active", source_type: "package_purchase", source_id: "p1", created_at: "2026-01-01T00:00:00Z" }],
      customer_memberships: [],
      package_purchases: [],
      membership_plans: [],
      prepaid_packages: [],
    });
    const { GET } = await import("../src/app/api/monetization/benefits/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("balance");
    expect(json).toHaveProperty("grants");
    expect(json).toHaveProperty("membership");
    expect(json).toHaveProperty("memberships");
    expect(json).toHaveProperty("purchases");
    expect(json.balance).toEqual({ rental: 7 });
    expect(json.grants).toHaveLength(1);
    expect(json.membership).toBeNull();
    expect(json.memberships).toEqual([]);
    expect(json.purchases).toEqual([]);
  });
});

describe("POST /api/monetization/membership/cancel", () => {
  it("404 with no active membership", async () => {
    const { POST } = await import("../src/app/api/monetization/membership/cancel/route");
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("sets cancel_at_period_end on a Stripe subscription membership", async () => {
    dbState.db = fakeDb({
      customer_memberships: [{ id: "mem-1", plan_id: "plan-month", status: "active", current_period_end: "2026-02-01T00:00:00Z", cancel_at_period_end: false, stripe_subscription_id: "sub_123" }],
      membership_plans: [{ id: "plan-month", name: "Monthly Charge" }],
    });
    const { POST } = await import("../src/app/api/monetization/membership/cancel/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).cancel_at_period_end).toBe(true);
    expect(events).toContain("stripe:POST /subscriptions/sub_123");
    expect(events).toContain("db:update:customer_memberships");
  });

  it("marks a one-time membership cancelled without touching Stripe", async () => {
    dbState.db = fakeDb({
      customer_memberships: [{ id: "mem-2", plan_id: "plan-once", status: "active", current_period_end: null, cancel_at_period_end: false, stripe_subscription_id: null }],
      membership_plans: [{ id: "plan-once", name: "One-time" }],
    });
    const { POST } = await import("../src/app/api/monetization/membership/cancel/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("cancelled");
    expect(events.some((e) => e.startsWith("stripe:") && e.includes("subscriptions"))).toBe(false);
    expect(events).toContain("db:update:customer_memberships");
  });
});
