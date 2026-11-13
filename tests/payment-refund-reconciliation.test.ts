import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 2.7 audit fixes — commercial payment defects.
 *  1. non_return_deadline resolves from the rental's LOCKED pricing_versions
 *     .non_return_after_hours on BOTH dispense paths (staff route + kiosk ack).
 *  2. charge.refunded reconciles rental payments AND the separate non-return
 *     fee PI: billing_ledger delta (cumulative, idempotent), credit release,
 *     rental_exceptions 'external_refund' + staff alert — never moves money.
 *  5. Unresolvable monetization disputes are logged, not silently dropped.
 */

const { dbState, spies } = vi.hoisted(() => ({
  dbState: { db: null as unknown },
  spies: {
    securityAlert: vi.fn(async () => true),
    receipt: vi.fn(async () => true),
    dispute: vi.fn(async () => true),
    failedHtml: vi.fn(async () => true),
    started: vi.fn(async () => true),
    returned: vi.fn(async () => true),
  },
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbState.db,
  anonClient: () => null,
  backendConfigured: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => ({ id: "44444444-4444-4444-8444-444444444444", role: "admin", email: "admin@zapnivo.com" }),
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/email-triggers", () => ({
  triggerPaymentReceipt: spies.receipt,
  triggerPaymentFailed: vi.fn(async () => true),
  triggerRentalStarted: spies.started,
  triggerRentalReturned: spies.returned,
  triggerRentalReminder: vi.fn(async () => true),
  triggerNonreturnNotice: vi.fn(async () => true),
}));
vi.mock("@/lib/email-extra-triggers", () => ({
  triggerPaymentDispute: spies.dispute,
  triggerPaymentFailedHtml: spies.failedHtml,
  triggerSecurityAlert: spies.securityAlert,
}));
vi.mock("@/lib/analytics", () => ({ trackServer: vi.fn() }));

import { processKioskEvent } from "@/lib/kiosk/lifecycle";
import { nonReturnDeadlineHours, nonReturnDeadlineIso } from "@/lib/payments/nonreturn-deadline";
import { reconcileNonReturnFeeRefund, reconcileRentalPaymentRefund } from "@/lib/payments/refund";
import { handleMonetizationDispute } from "@/lib/monetization/webhook";

type Row = Record<string, unknown>;

/** In-memory Supabase stub (same shape as command-ack-integrity.test.ts) + RPC mirror. */
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
    power_banks: ["serial"],
    kiosk_slots: ["kiosk_id,slot_number"],
    device_commands: ["idempotency_key"],
    billing_ledger: ["idempotency_key"],
  };
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    private onConflict: string | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, o?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = o?.onConflict ?? null; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run(): { data: Row[] | Row | null; error: { code: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          if (this.op === "upsert" && this.onConflict) {
            const cols = this.onConflict.split(",");
            const ex = rows.find((r) => cols.every((c) => eqv(r[c], item[c])));
            if (ex) { Object.assign(ex, item); out.push(ex); continue; }
          }
          for (const spec of UNIQ[this.name] ?? []) {
            const cols = spec.split(",");
            if (cols.some((c) => item[c] == null)) continue;
            if (rows.some((r) => cols.every((c) => eqv(r[c], item[c]))))
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          const row: Row = { ...item };
          if (row.id == null) row.id = `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
          rows.push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      if (this.op === "delete") {
        const hit = rows.filter(match);
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: hit, error: null };
      }
      let out = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }

    private finish() {
      const { data, error } = this.run();
      return { data, error };
    }
    single() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      return { data: rows[0], error: null };
    }
    maybeSingle() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }

  const db = {
    from: (t: string) => new QB(t),
    rpc: async (fn: string, args: Row) => {
      if (fn === "release_rental_reservations") {
        const rows = ensure("entitlement_reservations")
          .filter((r) => r.rental_id === args.p_rental_id && r.status === "reserved");
        rows.forEach((r) => { r.status = "released"; });
        return { data: rows.length, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, tables };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const RID = "11111111-1111-4111-8111-111111111111";
const PID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-02-01T12:00:00.000Z");

const pricingVersion = (over: Row = {}): Row => ({
  id: "pv-48", approved: true, non_return_after_hours: 48,
  first_hour_cents: 699, additional_hour_cents: 699, first_24h_cap_cents: 16776,
  additional_day_cents: null, non_return_max_cents: 4500, ...over,
});

const rental = (over: Row = {}): Row => ({
  id: RID, reference: "ZR-TEST", state: "dispense_pending", pricing_version: "pv-48",
  power_bank_id: "bank-1", kiosk_id: "kiosk-1", non_return_deadline: null,
  returned_at: null, created_at: "2026-02-01T10:00:00.000Z", ...over,
});

const hoursBetween = (fromIso: string, toIso: string) =>
  (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3600_000;

beforeEach(() => {
  for (const k of Object.keys(spies) as (keyof typeof spies)[]) spies[k].mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

/* ── 1. Deadline from the locked pricing version ────────────────────────── */

describe("non-return deadline resolution", () => {
  it("uses the rental's locked pricing_versions.non_return_after_hours", async () => {
    const { db } = fakeDb({
      rentals: [rental()],
      pricing_versions: [pricingVersion()],
    });
    dbState.db = db;
    expect(await nonReturnDeadlineHours(db, RID)).toBe(48);
    const iso = await nonReturnDeadlineIso(db, RID, NOW);
    expect(hoursBetween(NOW.toISOString(), iso)).toBe(48);
  });

  it("falls back to PRICING_V1 (24h) when the version is missing or unapproved", async () => {
    const missing = fakeDb({ rentals: [{ id: RID, pricing_version: "pv-gone" }], pricing_versions: [] });
    expect(await nonReturnDeadlineHours(missing.db, RID)).toBe(24);
    const unapproved = fakeDb({
      rentals: [rental()],
      pricing_versions: [pricingVersion({ approved: false })],
    });
    expect(await nonReturnDeadlineHours(unapproved.db, RID)).toBe(24);
    const noVersion = fakeDb({ rentals: [{ id: RID }], pricing_versions: [] });
    expect(await nonReturnDeadlineHours(noVersion.db, RID)).toBe(24);
  });
});

describe("kiosk dispense-ack deadline", () => {
  const KIOSK = { id: "kiosk-1", state: "online" };
  const CMD = "33333333-3333-4333-8333-333333333333";
  const ackSeed = () => ({
    kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online" }],
    rentals: [rental()],
    power_banks: [{ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false }],
    device_commands: [{
      id: CMD, kiosk_id: "kiosk-1", command: "dispense", idempotency_key: "pay-1",
      status: "sent", payload: { rental_id: RID }, created_at: "2026-02-01T10:30:00.000Z", resolved_at: null,
    }],
    pricing_versions: [pricingVersion()],
    kiosk_events: [], device_events: [], kiosk_slots: [], audit_logs: [], rental_exceptions: [],
    payments: [{ id: "pay-row-1", rental_id: RID, state: "authorized" }],
  });

  it("activates the rental with a 48h deadline from the locked version", async () => {
    const { db, tables } = fakeDb(ackSeed());
    dbState.db = db;
    const out = await processKioskEvent(db, KIOSK, {
      eventId: "ack-1", type: "dispense_acknowledged", commandId: "pay-1",
      powerBankId: "bank-1", hwTimestamp: "2026-02-01T11:59:30.000Z",
      occurredAt: "2026-02-01T11:59:30.000Z",
    }, NOW, { notifyStarted: spies.started, notifyReturned: spies.returned });
    expect(out).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].state).toBe("active");
    // Server-now base + 48h from the locked version (not the PRICING_V1 24h).
    expect(hoursBetween(NOW.toISOString(), String(tables.rentals[0].non_return_deadline))).toBe(48);
  });
});

describe("staff dispense route deadline", () => {
  it("writes the locked-version deadline on action=dispense", async () => {
    const { db, tables } = fakeDb({
      rentals: [rental()],
      pricing_versions: [pricingVersion()],
      payments: [], billing_ledger: [], audit_logs: [], app_logs: [],
    });
    dbState.db = db;
    const { POST } = await import("../src/app/api/rentals/[id]/route");
    const before = Date.now();
    const req = new Request("http://localhost/api/rentals/x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "dispense" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: RID }) });
    expect(res.status).toBe(200);
    expect(tables.rentals[0].state).toBe("active");
    const deadlineMs = new Date(String(tables.rentals[0].non_return_deadline)).getTime();
    // ~48h after server now (allow a few seconds of test drift).
    expect(deadlineMs - before).toBeGreaterThan(48 * 3600_000 - 10_000);
    expect(deadlineMs - before).toBeLessThan(48 * 3600_000 + 60_000);
  });
});

/* ── 2. charge.refunded reconciliation ──────────────────────────────────── */

const payRow = (over: Row = {}): { id: string; rental_id: string; state: string } & Row => ({
  id: PID, rental_id: RID, state: "captured",
  stripe_payment_intent_id: "pi_rent", amount_captured_cents: 2000,
  amount_refunded_cents: 0, ...over,
});
const charge = (over: Row = {}): Row => ({
  id: "ch_1", payment_intent: "pi_rent", amount: 2000,
  amount_captured: 2000, amount_refunded: 2000, ...over,
});
const refundRows = (tables: Record<string, Row[]>) =>
  (tables.billing_ledger ?? []).filter((r) => r.kind === "refund");
const exceptions = (tables: Record<string, Row[]>) =>
  (tables.rental_exceptions ?? []).filter((r) => r.kind === "external_refund");

describe("reconcileRentalPaymentRefund", () => {
  const seed = (over: Record<string, Row[]> = {}) => ({
    payments: [payRow()],
    rentals: [rental({ state: "returned" })],
    billing_ledger: [
      { id: "led-cap", rental_id: RID, kind: "rental_charge", amount_cents: 2000, status: "succeeded", stripe_payment_intent_id: "pi_rent", idempotency_key: "capture:pay" },
    ],
    entitlement_reservations: [
      { id: "res1", rental_id: RID, profile_id: "prof-1", grant_id: "g1", unit: "cent", amount: 500, status: "reserved" },
    ],
    rental_exceptions: [], profiles: [{ id: "s1", email: "staff@zapnivo.com", role: "staff" }],
    audit_logs: [], app_logs: [], ...over,
  });

  it("full external refund: posts ledger delta, releases reservations, flags exception + alerts staff", async () => {
    const { db, tables } = fakeDb(seed());
    dbState.db = db; // auditLog resolves the client via serviceClient()
    await reconcileRentalPaymentRefund(db, payRow(), charge(), "pi_rent");

    const refunds = refundRows(tables);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      rental_id: RID, amount_cents: -2000, status: "succeeded",
      stripe_payment_intent_id: "pi_rent", stripe_charge_id: "ch_1",
      idempotency_key: "webhook_refund:ch_1:2000",
    });
    expect(tables.entitlement_reservations[0].status).toBe("released");
    expect(exceptions(tables)).toHaveLength(1);
    expect(exceptions(tables)[0].detail).toMatchObject({ stripe_charge_id: "ch_1", source: "rental_payment" });
    expect(tables.audit_logs.some((a) => a.action === "stripe_external_refund")).toBe(true);
    expect(spies.securityAlert).toHaveBeenCalled();
    // Never touches the payments row state — the route owns that write.
    expect(tables.payments[0].state).toBe("captured");
  });

  it("is idempotent on replay and on cumulative partial refunds", async () => {
    const { db, tables } = fakeDb(seed());
    dbState.db = db;
    // Partial 500 first: ledger delta only, no exception.
    await reconcileRentalPaymentRefund(db, payRow(), charge({ amount_refunded: 500 }), "pi_rent");
    expect(refundRows(tables)).toHaveLength(1);
    expect(refundRows(tables)[0].amount_cents).toBe(-500);
    expect(exceptions(tables)).toHaveLength(0);

    // Cumulative 2000 (full): posts only the 1500 delta (2000-500), then flags once.
    await reconcileRentalPaymentRefund(db, payRow(), charge({ amount_refunded: 2000 }), "pi_rent");
    const refunds = refundRows(tables);
    expect(refunds.map((r) => Number(r.amount_cents)).sort((a, b) => a - b)).toEqual([-1500, -500]);
    expect(refunds.reduce((a, r) => a + Number(r.amount_cents), 0)).toBe(-2000);
    expect(exceptions(tables)).toHaveLength(1);

    // Replay of the same cumulative state: no new rows anywhere.
    await reconcileRentalPaymentRefund(db, payRow(), charge({ amount_refunded: 2000 }), "pi_rent");
    expect(refundRows(tables)).toHaveLength(2);
    expect(exceptions(tables)).toHaveLength(1);
  });

  it("does NOT double-post refunds already ledgered by the in-app admin route", async () => {
    const { db, tables } = fakeDb(seed({
      billing_ledger: [
        { id: "led-cap", rental_id: RID, kind: "rental_charge", amount_cents: 2000, status: "succeeded", stripe_payment_intent_id: "pi_rent", idempotency_key: "capture:pay" },
        // Admin-issued $5 refund already recorded (refund:{stripe_refund_id}).
        { id: "led-ref", rental_id: RID, kind: "refund", amount_cents: -500, status: "succeeded", stripe_payment_intent_id: "pi_rent", idempotency_key: "refund:re_1" },
      ],
    }));
    dbState.db = db;
    // Stripe now reports cumulative 500 refunded — fully covered by our ledger.
    await reconcileRentalPaymentRefund(db, payRow(), charge({ amount: 2000, amount_captured: 2000, amount_refunded: 500 }), "pi_rent");
    expect(refundRows(tables)).toHaveLength(1); // only the admin row
    expect(refundRows(tables)[0].idempotency_key).toBe("refund:re_1");
    expect(exceptions(tables)).toHaveLength(0);
    expect(spies.securityAlert).not.toHaveBeenCalled();
  });
});

describe("reconcileNonReturnFeeRefund", () => {
  it("reconciles a refunded fee PI against billing_ledger and flips the fee row", async () => {
    const { db, tables } = fakeDb({
      billing_ledger: [
        { id: "fee-1", rental_id: RID, kind: "non_return_fee", amount_cents: 4500, status: "succeeded", stripe_payment_intent_id: "pi_fee", stripe_charge_id: "ch_fee", idempotency_key: "nonreturn:r1" },
      ],
      rental_exceptions: [], profiles: [], audit_logs: [], app_logs: [],
    });
    dbState.db = db; // auditLog resolves the client via serviceClient()
    const handled = await reconcileNonReturnFeeRefund(db, {
      id: "ch_fee", payment_intent: "pi_fee", amount: 4500, amount_captured: 4500, amount_refunded: 4500,
    }, "pi_fee");
    expect(handled).toBe(true);
    const fee = tables.billing_ledger.find((r) => r.id === "fee-1");
    expect(fee?.status).toBe("refunded");
    const refund = tables.billing_ledger.find((r) => r.kind === "refund");
    expect(refund).toMatchObject({ rental_id: RID, amount_cents: -4500, stripe_payment_intent_id: "pi_fee" });
    expect(exceptions(tables)).toHaveLength(1);

    // Replay: idempotent — fee already 'refunded', no second ledger row.
    await reconcileNonReturnFeeRefund(db, {
      id: "ch_fee", payment_intent: "pi_fee", amount: 4500, amount_captured: 4500, amount_refunded: 4500,
    }, "pi_fee");
    expect(tables.billing_ledger.filter((r) => r.kind === "refund")).toHaveLength(1);
    expect(exceptions(tables)).toHaveLength(1);
  });

  it("returns false for PIs that own no fee ledger row", async () => {
    const { db } = fakeDb({ billing_ledger: [] });
    expect(await reconcileNonReturnFeeRefund(db, charge(), "pi_unknown")).toBe(false);
  });
});

/* ── Webhook route e2e: charge.refunded ─────────────────────────────────── */

const SECRET = "whsec_test";
const sign = (payload: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${payload}`).digest("hex")}`;

describe("stripe webhook charge.refunded (rental payment)", () => {
  it("syncs payments state AND reconciles ledger + exception", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    // No STRIPE_SECRET_KEY → resolveChargeProduct's retrievePaymentIntent fails
    // fast, so monetization resolution returns false without network.
    const { db, tables } = fakeDb({
      stripe_events: [], payments: [payRow()], rentals: [rental({ state: "returned" })],
      billing_ledger: [{ id: "led-cap", rental_id: RID, kind: "rental_charge", amount_cents: 2000, status: "succeeded", stripe_payment_intent_id: "pi_rent", idempotency_key: "capture:pay" }],
      entitlement_reservations: [], rental_exceptions: [], profiles: [], audit_logs: [], app_logs: [],
      gift_credits: [], package_purchases: [], group_credit_purchases: [], ad_ledger: [], advertising_campaigns: [],
    });
    dbState.db = db;
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const payload = JSON.stringify({
      id: "evt_refund_1", type: "charge.refunded",
      data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_rent", amount: 2000, amount_captured: 2000, amount_refunded: 2000 } },
    });
    const t = Math.floor(Date.now() / 1000);
    const res = await POST(new Request("http://localhost/api/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": sign(payload, t) }, body: payload,
    }));
    expect(res.status).toBe(200);
    expect(tables.payments[0]).toMatchObject({ state: "refunded", amount_refunded_cents: 2000 });
    expect(refundRows(tables)).toHaveLength(1);
    expect(refundRows(tables)[0].amount_cents).toBe(-2000);
    expect(exceptions(tables)).toHaveLength(1);
  });
});

/* ── 5. Dispute drop visibility ─────────────────────────────────────────── */

describe("handleMonetizationDispute unresolved PI", () => {
  it("returns false for unresolvable PIs (ad/unknown) — caller logs the drop", async () => {
    const { db } = fakeDb({});
    dbState.db = db;
    const handled = await handleMonetizationDispute(db, {
      id: "dp_ad", payment_intent: "pi_ad", amount: 5000, reason: "fraudulent", status: "needs_response",
    });
    expect(handled).toBe(false);
  });
});
