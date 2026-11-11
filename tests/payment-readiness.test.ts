import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Payment readiness tests. Env vars are manipulated directly (the lib reads
 * process.env at call time). The fake DB is a minimal thenable query builder.
 * Asserts above all: the report NEVER contains secret material.
 */

const { session, dbRef } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbRef: { db: null as unknown },
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => session.user,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbRef.db,
  anonClient: () => null,
  backendConfigured: () => true,
}));

import { NullKioskAdapter } from "@/lib/kiosk/adapter";
import { paymentReadiness, stripeMode } from "@/lib/payments/readiness";
import { GET } from "@/app/api/admin/payments/readiness/route";

/* ── Fake DB ─────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>, missing: string[] = []) {
  return {
    from(table: string) {
      const state = { eqs: [] as [string, unknown][], head: false, mode: "select" as string };
      const match = () =>
        missing.includes(table) ? { data: null, error: { message: "relation does not exist", code: "42P01" }, count: null }
          : {
              data: (tables[table] ?? []).filter((r) => state.eqs.every(([c, v]) => r[c] === v)),
              error: null,
              count: (tables[table] ?? []).filter((r) => state.eqs.every(([c, v]) => r[c] === v)).length,
            };
      const q: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) state.head = true; return q; },
        eq: (c: string, v: unknown) => { state.eqs.push([c, v]); return q; },
        limit: () => q,
        insert: () => { state.mode = "insert"; return q; },
        update: () => { state.mode = "update"; return q; },
        maybeSingle: async () => {
          const m = match();
          if (m.error) return { data: null, error: m.error };
          return { data: (m.data as Row[])[0] ?? null, error: null };
        },
        single: async () => {
          const m = match();
          if (m.error) return { data: null, error: m.error };
          return { data: (m.data as Row[])[0] ?? null, error: null };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          const m = match();
          const out = state.head ? { count: m.count, error: m.error, data: null } : { data: m.error ? null : m.data, error: m.error };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "GIFT_SALES_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  session.user = { id: "admin-1", email: "a@zapnivo.com", role: "admin", organizationId: null };
  dbRef.db = null;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const FULL_TABLES = {
  membership_plans: [{ id: "p1", active: true }, { id: "p2", active: false }],
  prepaid_packages: [{ id: "k1", active: true }],
  stripe_events: [{ id: "evt_1" }],
  billing_ledger: [{ id: "bl_1" }],
};

describe("paymentReadiness", () => {
  it("reports not_ready with no Stripe key and no secrets in output", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const r = await paymentReadiness(fakeDb(FULL_TABLES), new NullKioskAdapter());
    expect(r.overall).toBe("not_ready");
    expect(r.stripe).toEqual({ secretKey: false, webhookSecret: false, mode: "unknown" });
    expect(r.kiosk).toBe("none");
    expect(r.reconciliation).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("sk_");
  });

  it("is ready when Stripe test-mode key + webhook + products + reconciliation all present", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_" + "fake".repeat(10);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fakevalue";
    delete process.env.GIFT_SALES_ENABLED;
    const r = await paymentReadiness(fakeDb(FULL_TABLES), new NullKioskAdapter());
    expect(r.overall).toBe("ready");
    expect(r.stripe.mode).toBe("test");
    expect(r.webhookEndpoint).toBe("configured");
    expect(r.products).toEqual({ plans: 1, packages: 1 });
    expect(r.gifts).toBe("awaiting_legal");
    const json = JSON.stringify(r);
    expect(json).not.toContain("sk_test_");
    expect(json).not.toContain("whsec_");
    expect(json).not.toContain("fakefakefake");
    expect(json).not.toContain("fakevalue");
  });

  it("is partial when the webhook secret is missing", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_51realkeymaterial";
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const r = await paymentReadiness(fakeDb(FULL_TABLES), new NullKioskAdapter());
    expect(r.overall).toBe("partial");
    expect(r.stripe.mode).toBe("live");
    expect(r.webhookEndpoint).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain("sk_live_");
    expect(JSON.stringify(r)).not.toContain("realkeymaterial");
  });

  it("is partial when no products are active or reconciliation tables are missing", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    const r1 = await paymentReadiness(fakeDb({ membership_plans: [], prepaid_packages: [] }), new NullKioskAdapter());
    expect(r1.overall).toBe("partial");
    expect(r1.products).toEqual({ plans: 0, packages: 0 });
    const r2 = await paymentReadiness(fakeDb(FULL_TABLES, ["billing_ledger"]), new NullKioskAdapter());
    expect(r2.overall).toBe("partial");
    expect(r2.reconciliation).toBe("missing");
  });

  it("reports unknown products and reconciliation when db is absent", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    const r = await paymentReadiness(null, new NullKioskAdapter());
    expect(r.products).toEqual({ plans: null, packages: null });
    expect(r.reconciliation).toBe("unknown");
    expect(r.overall).toBe("partial");
  });

  it("reports gifts enabled only when GIFT_SALES_ENABLED=1", async () => {
    process.env.GIFT_SALES_ENABLED = "1";
    const r = await paymentReadiness(null, new NullKioskAdapter());
    expect(r.gifts).toBe("enabled");
  });

  it("stripeMode never leaks the key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_secret";
    expect(stripeMode()).toBe("live");
    process.env.STRIPE_SECRET_KEY = "rk_test_restricted";
    expect(stripeMode()).toBe("unknown");
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeMode()).toBe("unknown");
  });
});

describe("GET /api/admin/payments/readiness", () => {
  it("rejects non-staff", async () => {
    session.user = { id: "u1", email: "c@x.com", role: "customer", organizationId: null };
    dbRef.db = fakeDb(FULL_TABLES);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns the readiness report for staff without secrets", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_routekey";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_routerfake";
    dbRef.db = fakeDb(FULL_TABLES);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("ready");
    const json = JSON.stringify(body);
    expect(json).not.toContain("sk_test_");
    expect(json).not.toContain("whsec_");
    expect(json).not.toContain("routekey");
  });
});
