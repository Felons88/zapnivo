import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLedger, hasOpenLedgerEntry, markLedger, succeededLedgerCents, type LedgerEntry } from "../src/lib/payments/ledger";
import { chargeNonReturnFee } from "../src/lib/payments/nonreturn";

/** Minimal chainable Supabase fake: rows live in `tables`, filters are eq/in matches. */
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const inserts: { table: string; row: Row }[] = [];
  const updates: { table: string; patch: Row; filters: [string, unknown][] }[] = [];
  const db = {
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let op: "select" | "insert" | "update" | "upsert" = "select";
      let payload: Row | null = null;
      let headCount = false;
      const match = (r: Row) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
      const run = async () => {
        if (op === "insert" && payload) {
          inserts.push({ table, row: payload });
          if (payload.idempotency_key && rows().some((r) => r.idempotency_key === payload!.idempotency_key)) {
            return { data: null, error: { code: "23505", message: "duplicate" }, count: null };
          }
          const row = { id: `row_${inserts.length}`, ...payload };
          rows().push(row);
          return { data: [row], error: null, count: null };
        }
        if (op === "update" && payload) {
          updates.push({ table, patch: payload, filters: [...filters] });
          const hit = rows().filter(match);
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit, error: null, count: null };
        }
        if (op === "upsert" && payload) {
          const existing = rows().find((r) => r.stripe_refund_id === payload!.stripe_refund_id || r.id === payload!.id);
          if (existing) Object.assign(existing, payload); else rows().push({ id: `row_${rows().length + 1}`, ...payload });
          return { data: null, error: null, count: null };
        }
        const hit = rows().filter(match);
        if (headCount) return { data: null, error: null, count: hit.length };
        return { data: hit, error: null, count: null };
      };
      const q: Record<string, unknown> = {};
      q.select = (_c?: unknown, opts?: { head?: boolean }) => { if (opts?.head) headCount = true; return q; };
      q.insert = (row: Row) => { op = "insert"; payload = row; return q; };
      q.update = (patch: Row) => { op = "update"; payload = patch; return q; };
      q.upsert = (row: Row) => { op = "upsert"; payload = row; return q; };
      q.eq = (k: string, v: unknown) => { filters.push([k, v]); return q; };
      q.in = (k: string, vs: unknown[]) => { filters.push([k, vs]); return q; };
      q.neq = () => q; q.not = () => q; q.is = () => q; q.ilike = () => q;
      q.limit = () => q; q.order = () => q; q.delete = () => q;
      q.maybeSingle = async () => { const r = await run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error, count: r.count }; };
      q.single = async () => { const r = await run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error, count: r.count }; };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
      return q;
    },
  };
  return { db: db as never, inserts, updates };
}

const RID = "11111111-1111-1111-1111-111111111111";
const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  rentalId: RID, kind: "non_return_fee", amountCents: 4500, idempotencyKey: `nonreturn:${RID}`, ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("billing ledger", () => {
  it("appends a row and rejects a duplicate idempotency key", async () => {
    const { db, inserts } = fakeDb({ billing_ledger: [] });
    const first = await appendLedger(db, entry());
    expect(first.ok).toBe(true);
    const dup = await appendLedger(db, entry());
    expect(dup).toEqual({ ok: false, code: "23505" });
    expect(inserts).toHaveLength(2); // both attempted; the unique key is what protects the table
  });
  it("marks status without touching amount, and sums succeeded fees", async () => {
    const { db, updates } = fakeDb({ billing_ledger: [] });
    await appendLedger(db, entry({ status: "pending" }));
    expect(await markLedger(db, `nonreturn:${RID}`, { status: "succeeded", stripePaymentIntentId: "pi_fee", stripeChargeId: "ch_1" })).toBe(true);
    expect(updates[0].patch).toMatchObject({ status: "succeeded", stripe_payment_intent_id: "pi_fee", stripe_charge_id: "ch_1" });
    expect(updates[0].patch.amount_cents).toBeUndefined();
    expect(await succeededLedgerCents(db, RID, "non_return_fee")).toBe(4500);
    expect(await hasOpenLedgerEntry(db, RID, "non_return_fee")).toBe(true);
    expect(await hasOpenLedgerEntry(db, RID, "refund")).toBe(false);
  });
});

describe("chargeNonReturnFee", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const feeDb = (ledger: Row[] = []) => fakeDb({
    billing_ledger: ledger,
    payments: [{ id: "pay_1", rental_id: RID, customer_phone: null }],
    rentals: [{ id: RID, non_return_fee_status: "none" }],
    sms_messages: [], audit_logs: [],
  });
  const args = { rentalId: RID, reference: "ZR-TEST1234", holdPaymentIntentId: "pi_hold", feeCents: 4500, actor: "admin-1" };

  function stripe(handlers: { hold?: unknown; create?: { status?: number; body?: unknown } }) {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const calls: { url: string; method: string; idem: string | null; params: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const params = new URLSearchParams(init?.body ?? "");
      calls.push({ url, method, idem: init?.headers?.["Idempotency-Key"] ?? null, params });
      if (method === "GET") return json(handlers.hold ?? { id: "pi_hold", status: "requires_capture", customer: "cus_1", payment_method: "pm_1", latest_charge: null });
      if (handlers.create?.status && handlers.create.status >= 400) return json(handlers.create.body ?? { error: { code: "card_declined", message: "declined" } }, handlers.create.status);
      return json(handlers.create?.body ?? { id: "pi_fee_1", status: "succeeded", amount: 4500, latest_charge: "ch_fee_1" });
    }));
    return calls;
  }

  it("creates a separate off-session PI with the canonical idempotency key and ledgers it", async () => {
    const { db, updates } = feeDb();
    const calls = stripe({});
    const out = await chargeNonReturnFee(db, args);
    expect(out).toMatchObject({ status: "charged", cents: 4500, paymentIntentId: "pi_fee_1" });

    const create = calls.find((c) => c.method === "POST");
    expect(create?.url).toContain("/payment_intents");
    expect(create?.idem).toBe(`nonreturn:${RID}`);
    expect(create?.params.get("amount")).toBe("4500");
    expect(create?.params.get("confirm")).toBe("true");
    expect(create?.params.get("off_session")).toBe("true");
    expect(create?.params.get("payment_method")).toBe("pm_1");
    expect(create?.params.get("customer")).toBe("cus_1");
    expect(create?.params.get("metadata[kind]")).toBe("non_return_fee");
    expect(create?.params.get("metadata[rental_id]")).toBe(RID);

    const led = updates.find((u) => u.table === "billing_ledger");
    expect(led?.patch).toMatchObject({ status: "succeeded", stripe_payment_intent_id: "pi_fee_1", stripe_charge_id: "ch_fee_1" });
    const rent = updates.find((u) => u.table === "rentals");
    expect(rent?.patch).toMatchObject({ non_return_fee_status: "charged" });
  });

  it("never charges twice when a succeeded fee row exists", async () => {
    const { db } = feeDb([{ id: "l1", rental_id: RID, kind: "non_return_fee", status: "succeeded", amount_cents: 4500, idempotency_key: `nonreturn:${RID}` }]);
    const calls = stripe({});
    const out = await chargeNonReturnFee(db, args);
    expect(out.status).toBe("skipped");
    expect(calls).toHaveLength(0); // blocked before even reading the hold PI
  });

  it("records a failed attempt in the ledger and flags the rental on a Stripe decline", async () => {
    const { db, updates } = feeDb();
    stripe({ create: { status: 402, body: { error: { code: "card_declined", message: "declined" } } } });
    const out = await chargeNonReturnFee(db, args);
    expect(out.status).toBe("failed");
    const led = updates.find((u) => u.table === "billing_ledger");
    expect(led?.patch.status).toBe("failed");
    const rent = updates.find((u) => u.table === "rentals");
    expect(rent?.patch).toMatchObject({ non_return_fee_status: "failed" });
  });

  it("marks non-succeeded PI statuses (e.g. requires_action) as failed", async () => {
    const { db, updates } = feeDb();
    stripe({ create: { body: { id: "pi_fee_2", status: "requires_action", latest_charge: null } } });
    const out = await chargeNonReturnFee(db, args);
    expect(out.status).toBe("failed");
    expect(updates.find((u) => u.table === "billing_ledger")?.patch.status).toBe("failed");
  });

  it("refuses when the original checkout saved no payment method", async () => {
    const { db } = feeDb();
    const calls = stripe({ hold: { id: "pi_hold", status: "requires_capture", customer: "cus_1", payment_method: null, latest_charge: null } });
    const out = await chargeNonReturnFee(db, args);
    expect(out.status).toBe("error");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("suffixes the idempotency key on a retry after a failed attempt", async () => {
    const { db } = feeDb([{ id: "l1", rental_id: RID, kind: "non_return_fee", status: "failed", amount_cents: 4500, idempotency_key: `nonreturn:${RID}` }]);
    const calls = stripe({});
    const out = await chargeNonReturnFee(db, args);
    expect(out.status).toBe("charged");
    expect(calls.find((c) => c.method === "POST")?.idem).toBe(`nonreturn:${RID}:2`);
  });
});

describe("admin refund route writes a ledger row", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock("../src/lib/auth"); vi.doUnmock("../src/lib/supabase"); });

  it("records kind=refund with negative cents keyed by the Stripe refund id", async () => {
    const PAY = "22222222-2222-4222-8222-222222222222";
    const ADMIN = "33333333-3333-3333-3333-333333333333";
    const { db, inserts } = fakeDb({
      payments: [{ id: PAY, rental_id: RID, state: "captured", stripe_payment_intent_id: "pi_1", amount_captured_cents: 700, amount_refunded_cents: 0, rentals: { reference: "ZR-TEST1234" } }],
      refund_requests: [], refunds: [], billing_ledger: [], audit_logs: [],
    });
    vi.doMock("../src/lib/auth", () => ({ getSessionUser: async () => ({ id: ADMIN, role: "admin", email: "admin@zapnivo.com" }) }));
    vi.doMock("../src/lib/supabase", () => ({ serviceClient: () => db, anonClient: () => null, backendConfigured: () => true }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: "re_1", status: "succeeded" })));

    const { POST } = await import("../src/app/api/admin/payments/[id]/refund/route");
    const req = new Request(`http://localhost/api/admin/payments/${PAY}/refund`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: 300, reason: "partial refund test" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: PAY }) });
    expect(res.status).toBe(200);

    const led = inserts.find((i) => i.table === "billing_ledger");
    expect(led?.row).toMatchObject({
      rental_id: RID, kind: "refund", amount_cents: -300, status: "succeeded",
      stripe_payment_intent_id: "pi_1", idempotency_key: "refund:re_1",
    });
  });
});
