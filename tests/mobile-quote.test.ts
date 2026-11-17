import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { resetRateLimits } from "../src/lib/rate-limit";

/**
 * /api/mobile/checkout/quote — read-only promo validation + server-priced quote.
 * The DB is faked per table; auth comes from the mocked mobileCustomer.
 */

const KIOSK = { id: "k1", state: "online", test_mode: false, venues: { published: true } };
const PRICING = {
  id: "pv1", approved: true, first_hour_cents: 699, additional_hour_cents: 699,
  first_24h_cap_cents: 16776, additional_day_cents: null, non_return_max_cents: 4500, non_return_after_hours: 24,
  hold_cents: 1200,
};
const PROMO = {
  code: "SAVE10", percent_off: 10, amount_off_cents: null, active: true,
  starts_at: null, expires_at: null, max_redemptions: null, redemptions: 0,
};

type TableResult = { data?: unknown; count?: number; error?: unknown };

const chain = (result: TableResult) => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in", "ilike", "or", "gte", "lte", "single", "update", "insert", "neq"])
    c[m] = () => c;
  c.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null });
  // awaiting the chain itself resolves { count } for head-count queries
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, count: result.count ?? 0, error: result.error ?? null }).then(res, rej);
  return c;
};

let authed = true;
const tables: Record<string, TableResult> = {};
const db = { from: (t: string) => chain(tables[t] ?? {}) };

vi.doMock("../src/lib/mobile", () => ({
  isResponse: (v: unknown) => v instanceof NextResponse,
  mobileCustomer: async () =>
    authed
      ? { user: { id: "00000000-0000-4000-8000-000000000001", role: "customer", email: "a@b.com" }, db, email: "a@b.com", name: "a" }
      : NextResponse.json({ error: "Sign in again." }, { status: 401 }),
}));
vi.doMock("../src/lib/kiosk/availability", () => ({ stationMaintenanceBlock: async () => null }));
vi.doMock("../src/lib/observability", () => ({ newTraceId: () => "t", recordLog: () => {}, recordSpan: () => {}, reportError: () => {} }));

const post = (body: unknown) =>
  new Request("http://localhost/api/mobile/checkout/quote", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify(body),
  });
const ok = { station_id: "ZN-TEST1", bank_count: 1 };

describe("mobile checkout quote", () => {
  afterEach(() => {
    authed = true;
    for (const k of Object.keys(tables)) delete tables[k];
    resetRateLimits();
  });

  it("rejects unauthenticated callers", async () => {
    authed = false;
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    expect((await POST(post(ok))).status).toBe(401);
  });

  it("422s on invalid input", async () => {
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    expect((await POST(post({ station_id: "!!" }))).status).toBe(422);
    expect((await POST(post({ ...ok, bank_count: 4 }))).status).toBe(422);
    expect((await POST(post({ ...ok, promo_code: "x" }))).status).toBe(422);
  });

  it("409s when the station cannot serve rentals", async () => {
    tables["kiosks"] = { data: null };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    const res = await POST(post(ok));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("station_unavailable");
  });

  it("quotes hold + first-hour estimate from approved pricing", async () => {
    tables["kiosks"] = { data: KIOSK };
    tables["pricing_versions"] = { data: PRICING };
    tables["kiosk_slots"] = { count: 3 };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    const res = await POST(post({ ...ok, bank_count: 2 }));
    expect(res.status).toBe(200);
    const { quote } = await res.json();
    expect(quote.hold_cents).toBe(2400); // $12 per bank × 2 banks
    expect(quote.first_hour_estimate_cents).toBe(1398);
    expect(quote.additional_hour_cents).toBe(699);
    expect(quote.non_return_max_cents).toBe(4500);
    expect(quote.ready_banks).toBe(3);
    expect(quote.promo).toBeNull();
  });

  it("validates a usable promo without reserving it", async () => {
    tables["kiosks"] = { data: KIOSK };
    tables["pricing_versions"] = { data: PRICING };
    tables["kiosk_slots"] = { count: 2 };
    tables["promo_codes"] = { data: PROMO };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    const res = await POST(post({ ...ok, promo_code: "SAVE10" }));
    expect(res.status).toBe(200);
    const { quote } = await res.json();
    expect(quote.promo.valid).toBe(true);
    expect(quote.promo.discount_preview_cents).toBe(70); // 10% of 699
  });

  it("flags an invalid or expired promo", async () => {
    tables["kiosks"] = { data: KIOSK };
    tables["pricing_versions"] = { data: PRICING };
    tables["kiosk_slots"] = { count: 2 };
    tables["promo_codes"] = { data: { ...PROMO, active: false } };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    const res = await POST(post({ ...ok, promo_code: "SAVE10" }));
    expect((await res.json()).quote.promo.valid).toBe(false);
  });

  it("503s when no approved pricing exists", async () => {
    tables["kiosks"] = { data: KIOSK };
    tables["pricing_versions"] = { data: null };
    tables["kiosk_slots"] = { count: 2 };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    const res = await POST(post(ok));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("pricing_not_approved");
  });

  it("409s when no power banks are ready", async () => {
    tables["kiosks"] = { data: KIOSK };
    tables["pricing_versions"] = { data: PRICING };
    tables["kiosk_slots"] = { count: 0 };
    const { POST } = await import("../src/app/api/mobile/checkout/quote/route");
    expect((await POST(post(ok))).status).toBe(409);
  });
});
