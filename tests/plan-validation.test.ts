import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin monetization PATCH route tests — validation + activation gate.
 * Auth and Supabase are mocked; the fake DB resolves eq-filtered rows.
 */

const { session, dbState } = vi.hoisted(() => ({
  session: { user: null as null | { id: string; email: string; role: string; organizationId: string | null } },
  dbState: { tables: {} as Record<string, Record<string, unknown>[]> },
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => session.user,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => fakeDb(),
  anonClient: () => null,
  backendConfigured: () => true,
}));
vi.mock("@/lib/observability", () => ({ recordLog: vi.fn(), reportError: vi.fn() }));

import {
  MAX_PRICE_CENTS,
  benefitPatchSchema,
  entitlementFromBenefit,
  packageCompleteness,
  packagePatchSchema,
  planCompleteness,
  planPatchSchema,
} from "@/lib/monetization/catalog-validation";
import { PATCH as patchPlan } from "@/app/api/admin/monetization/plans/[id]/route";
import { PATCH as patchPackage } from "@/app/api/admin/monetization/packages/[id]/route";

/* ── Fake DB ─────────────────────────────────────────────────────────────── */

function fakeDb() {
  const rows = (t: string) => dbState.tables[t] ?? [];
  return {
    from(table: string) {
      const state = { eqs: [] as [string, unknown][], mode: "select" as "select" | "update" | "insert" };
      const match = () => rows(table).filter((r) => state.eqs.every(([c, v]) => r[c] === v));
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { state.eqs.push([c, v]); return q; },
        insert: () => { state.mode = "insert"; return q; },
        update: () => { state.mode = "update"; return q; },
        maybeSingle: async () => {
          if (state.mode === "update") {
            const m = match();
            return { data: m[0] ? { id: m[0].id } : null, error: null };
          }
          return { data: match()[0] ?? null, error: null };
        },
        single: async () => ({ data: match()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: match(), error: null }).then(res, rej),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

const STAFF = { id: "admin-1", email: "a@zapnivo.com", role: "admin", organizationId: null };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = "p1") =>
  new Request(`http://localhost/api/admin/monetization/x/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  session.user = STAFF;
  dbState.tables = {
    membership_plans: [
      { id: "p1", name: "", price_cents: 0, interval: "month", benefit: null, active: false },
      { id: "p2", name: "Pro", price_cents: 999, interval: "month", benefit: { rentals: 4 }, active: true },
    ],
    prepaid_packages: [
      { id: "k1", name: "", price_cents: 0, units: 0, kind: "rental", active: false },
      { id: "k2", name: "10-pack", price_cents: 4900, units: 10, kind: "rental", active: true },
    ],
  };
});

describe("catalog-validation schemas", () => {
  it("rejects empty/over-long names and out-of-range prices", () => {
    expect(planPatchSchema.safeParse({ name: "" }).success).toBe(false);
    expect(planPatchSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(planPatchSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
    expect(planPatchSchema.safeParse({ name: "Fine name" }).success).toBe(true);
    expect(planPatchSchema.safeParse({ price_cents: 0 }).success).toBe(false);
    expect(planPatchSchema.safeParse({ price_cents: -5 }).success).toBe(false);
    expect(planPatchSchema.safeParse({ price_cents: 1.5 }).success).toBe(false);
    expect(planPatchSchema.safeParse({ price_cents: MAX_PRICE_CENTS + 1 }).success).toBe(false);
    expect(planPatchSchema.safeParse({ price_cents: MAX_PRICE_CENTS }).success).toBe(true);
  });

  it("enforces billing interval enum", () => {
    expect(planPatchSchema.safeParse({ interval: "week" }).success).toBe(false);
    for (const i of ["month", "year", "one_time"]) {
      expect(planPatchSchema.safeParse({ interval: i }).success).toBe(true);
    }
  });

  it("validates benefit payloads require a positive entitlement", () => {
    expect(benefitPatchSchema.safeParse({ rentals: 0, rental_minutes: 0 }).success).toBe(false);
    expect(benefitPatchSchema.safeParse({ rentals: -1 }).success).toBe(false);
    expect(benefitPatchSchema.safeParse({ rentals: 3 }).success).toBe(true);
    expect(benefitPatchSchema.safeParse({ unexpected: 1 }).success).toBe(false);
  });

  it("package schema enforces positive units and price", () => {
    expect(packagePatchSchema.safeParse({ units: 0 }).success).toBe(false);
    expect(packagePatchSchema.safeParse({ units: 2.5 }).success).toBe(false);
    expect(packagePatchSchema.safeParse({ price_cents: 0 }).success).toBe(false);
    expect(packagePatchSchema.safeParse({ units: 10, price_cents: 100 }).success).toBe(true);
  });

  it("completeness checks mirror what checkout needs", () => {
    expect(planCompleteness({ name: "Pro", price_cents: 999, interval: "month", benefit: { rental_minutes: 60 } }).complete).toBe(true);
    const bad = planCompleteness({ name: "", price_cents: 0, interval: "weekly", benefit: {} });
    expect(bad.complete).toBe(false);
    expect(bad.missing).toEqual(expect.arrayContaining(["name", "price_cents", "interval", "benefit"]));
    expect(entitlementFromBenefit({ credit_cents: 500 })).toEqual({ unit: "cent", amount: 500 });
    expect(entitlementFromBenefit(null)).toBeNull();
    expect(packageCompleteness({ name: "Pack", price_cents: 100, units: 5, kind: "rental" }).complete).toBe(true);
    expect(packageCompleteness({ name: "", price_cents: 0, units: 0, kind: "" }).missing).toEqual(
      expect.arrayContaining(["name", "price_cents", "units", "kind"]),
    );
  });
});

describe("PATCH /api/admin/monetization/plans/[id]", () => {
  it("rejects non-staff", async () => {
    session.user = { id: "u1", email: "c@x.com", role: "customer", organizationId: null };
    const res = await patchPlan(patch({ active: false }), params("p2"));
    expect(res.status).toBe(403);
  });

  it("rejects invalid field values with 422", async () => {
    expect((await patchPlan(patch({ price_cents: 0 }), params("p2"))).status).toBe(422);
    expect((await patchPlan(patch({ price_cents: 99_000_000 }), params("p2"))).status).toBe(422);
    expect((await patchPlan(patch({ name: "" }), params("p2"))).status).toBe(422);
    expect((await patchPlan(patch({ interval: "week" }), params("p2"))).status).toBe(422);
    expect((await patchPlan(patch({ benefit: { rentals: 0 } }), params("p2"))).status).toBe(422);
    expect((await patchPlan(patch({}), params("p2"))).status).toBe(422);
  });

  it("blocks activation of an incomplete plan", async () => {
    const res = await patchPlan(patch({ active: true }), params("p1"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("plan_incomplete");
    expect(body.missing).toEqual(expect.arrayContaining(["name", "price_cents", "benefit"]));
  });

  it("allows activation once the patch completes the plan", async () => {
    const res = await patchPlan(
      patch({ active: true, name: "Starter", price_cents: 999, benefit: { rentals: 2 } }),
      params("p1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("still allows deactivating an incomplete plan", async () => {
    const res = await patchPlan(patch({ active: false }), params("p2"));
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/admin/monetization/packages/[id]", () => {
  it("blocks activation of an incomplete package", async () => {
    const res = await patchPackage(patch({ active: true }), params("k1"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("package_incomplete");
    expect(body.missing).toEqual(expect.arrayContaining(["name", "price_cents", "units"]));
  });

  it("allows activation when the patch supplies the missing fields", async () => {
    const res = await patchPackage(
      patch({ active: true, name: "Starter pack", price_cents: 999, units: 3 }),
      params("k1"),
    );
    expect(res.status).toBe(200);
  });

  it("rejects invalid units/price", async () => {
    expect((await patchPackage(patch({ units: 0 }), params("k2"))).status).toBe(422);
    expect((await patchPackage(patch({ price_cents: 0 }), params("k2"))).status).toBe(422);
  });
});
