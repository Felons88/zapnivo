import { describe, expect, it } from "vitest";
import {
  campaignAmountCents, handleAdChargeRefunded, handleAdCheckoutCompleted, handleAdPaymentIntent,
  type AdCampaignRow,
} from "../src/lib/ads/billing";

/** Minimal chainable Supabase fake: rows live in `tables`, filters are eq/neq/in/is matches. */
type Row = Record<string, unknown>;
type Filter = { k: string; op: "eq" | "neq" | "in" | "is"; v: unknown };
function fakeDb(tables: Record<string, Row[]>) {
  const inserts: { table: string; row: Row }[] = [];
  const updates: { table: string; patch: Row; filters: Filter[] }[] = [];
  const match = (filters: Filter[]) => (r: Row) => filters.every((f) => {
    if (f.op === "eq") return r[f.k] === f.v;
    if (f.op === "neq") return r[f.k] !== f.v;
    if (f.op === "in") return Array.isArray(f.v) && f.v.includes(r[f.k]);
    return f.v === null ? r[f.k] == null : r[f.k] === f.v;
  });
  const db = {
    from(table: string) {
      const rows = () => (tables[table] ??= []);
      const filters: Filter[] = [];
      let op: "select" | "insert" | "update" = "select";
      let payload: Row | null = null;
      let limitN: number | null = null;
      const run = async () => {
        if (op === "insert" && payload) {
          inserts.push({ table, row: payload });
          const row = { id: `row_${inserts.length}`, ...payload };
          rows().push(row);
          return { data: [row], error: null };
        }
        if (op === "update" && payload) {
          updates.push({ table, patch: payload, filters: [...filters] });
          const hit = rows().filter(match(filters));
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit, error: null };
        }
        let hit = rows().filter(match(filters));
        if (limitN !== null) hit = hit.slice(0, limitN);
        return { data: hit, error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.insert = (row: Row) => { op = "insert"; payload = row; return q; };
      q.update = (patch: Row) => { op = "update"; payload = patch; return q; };
      q.eq = (k: string, v: unknown) => { filters.push({ k, op: "eq", v }); return q; };
      q.neq = (k: string, v: unknown) => { filters.push({ k, op: "neq", v }); return q; };
      q.in = (k: string, vs: unknown[]) => { filters.push({ k, op: "in", v: vs }); return q; };
      q.is = (k: string, v: unknown) => { filters.push({ k, op: "is", v }); return q; };
      q.limit = (n: number) => { limitN = n; return q; };
      q.order = () => q;
      q.maybeSingle = async () => { const r = await run(); return { data: (r.data as Row[])[0] ?? null, error: r.error }; };
      q.single = async () => { const r = await run(); return { data: (r.data as Row[])[0] ?? null, error: r.error }; };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
      return q;
    },
  };
  return { db: db as never, inserts, updates };
}

const ORG = "org_1";
const campaign = (over: Partial<AdCampaignRow> = {}): AdCampaignRow => ({
  id: "camp_1", advertiser_org_id: ORG, name: "Spring push", status: "approved",
  budget_cents: 20000, spent_cents: 0, payment_status: "checkout_pending",
  pricing_model: "fixed", targeting: { placement: "kiosk_screen" },
  schedule: { starts_at: "2026-03-01T00:00:00Z", ends_at: "2026-03-15T00:00:00Z" },
  ...over,
});
const rateCard = (over: Row = {}): Row => ({
  id: "rc_1", placement: "kiosk_screen", pricing_model: "fixed",
  unit_price_cents: 5000, min_spend_cents: 0, duration_days: 7, active: true, ...over,
});

describe("campaignAmountCents", () => {
  it("fixed + rate card: unit price × scheduled days clamped to card minimum", async () => {
    const { db } = fakeDb({ ad_rate_cards: [rateCard()] });
    // 14 scheduled days > 7-day card minimum → 5000 × 14
    expect(await campaignAmountCents(db, campaign())).toMatchObject({ amountCents: 70000, model: "fixed", days: 14 });
  });
  it("fixed + rate card with short schedule clamps up to duration_days", async () => {
    const { db } = fakeDb({ ad_rate_cards: [rateCard()] });
    const c = campaign({ schedule: { starts_at: "2026-03-01T00:00:00Z", ends_at: "2026-03-03T00:00:00Z" } });
    expect(await campaignAmountCents(db, c)).toMatchObject({ amountCents: 35000, days: 7 });
  });
  it("fixed + rate card with no schedule uses the card duration", async () => {
    const { db } = fakeDb({ ad_rate_cards: [rateCard()] });
    expect(await campaignAmountCents(db, campaign({ schedule: {} }))).toMatchObject({ amountCents: 35000, days: 7 });
  });
  it("fixed without a rate card falls back to budget_cents", async () => {
    const { db } = fakeDb({ ad_rate_cards: [] });
    expect(await campaignAmountCents(db, campaign())).toMatchObject({ amountCents: 20000, model: "fixed" });
  });
  it("returns null when neither a rate card nor a budget exists", async () => {
    const { db } = fakeDb({ ad_rate_cards: [] });
    expect(await campaignAmountCents(db, campaign({ budget_cents: null }))).toBeNull();
  });
  it("cpm/cpc charge the full budget as prepaid credit", async () => {
    const { db } = fakeDb({ ad_rate_cards: [rateCard({ pricing_model: "cpm", unit_price_cents: 250, min_spend_cents: 5000 })] });
    const c = campaign({ pricing_model: "cpm", budget_cents: 30000 });
    expect(await campaignAmountCents(db, c)).toMatchObject({
      amountCents: 30000, model: "cpm", unitPriceCents: 250, minSpendCents: 5000, budgetCents: 30000,
    });
  });
  it("usage model without budget falls back to the card minimum spend", async () => {
    const { db } = fakeDb({ ad_rate_cards: [rateCard({ pricing_model: "cpc", min_spend_cents: 5000 })] });
    const c = campaign({ pricing_model: "cpc", budget_cents: null });
    expect(await campaignAmountCents(db, c)).toMatchObject({ amountCents: 5000, model: "cpc" });
  });
});

const sessionObj = (over: Row = {}): Row & { id: string } => ({
  id: "cs_1", payment_intent: "pi_1", amount_total: 70000, currency: "usd",
  customer: "cus_1", customer_details: { email: "ads@example.com" },
  metadata: { kind: "ad_campaign", campaign_id: "camp_1", advertiser_org_id: ORG },
  ...over,
});

describe("handleAdCheckoutCompleted", () => {
  it("marks the campaign paid, schedules it, and writes one ledger charge", async () => {
    const tables: Record<string, Row[]> = {
      advertising_campaigns: [campaign()],
      ad_ledger: [],
      advertiser_orgs: [{ id: ORG, name: "Acme", contact_email: "a@acme.com", stripe_customer_id: null }],
    };
    const { db, inserts } = fakeDb(tables);
    expect(await handleAdCheckoutCompleted(db, sessionObj())).toBe(true);

    const c = tables.advertising_campaigns[0];
    expect(c).toMatchObject({ payment_status: "paid", status: "scheduled", stripe_payment_intent_id: "pi_1", stripe_checkout_session_id: "cs_1" });
    const led = inserts.find((i) => i.table === "ad_ledger");
    expect(led?.row).toMatchObject({
      campaign_id: "camp_1", kind: "charge", amount_cents: 70000, status: "succeeded",
      stripe_payment_intent_id: "pi_1", note: "campaign_prepayment",
    });
    expect(tables.advertiser_orgs[0].stripe_customer_id).toBe("cus_1");
  });

  it("is idempotent: a replayed session.completed adds no second ledger charge", async () => {
    const tables: Record<string, Row[]> = { advertising_campaigns: [campaign()], ad_ledger: [], advertiser_orgs: [] };
    const { db, inserts } = fakeDb(tables);
    await handleAdCheckoutCompleted(db, sessionObj());
    await handleAdCheckoutCompleted(db, sessionObj({ id: "cs_2" }));
    expect(inserts.filter((i) => i.table === "ad_ledger")).toHaveLength(1);
    expect(tables.advertising_campaigns[0].payment_status).toBe("paid");
  });

  it("keeps an already-live campaign's status untouched", async () => {
    const tables: Record<string, Row[]> = {
      advertising_campaigns: [campaign({ status: "live", payment_status: "checkout_pending" })],
      ad_ledger: [], advertiser_orgs: [],
    };
    const { db } = fakeDb(tables);
    await handleAdCheckoutCompleted(db, sessionObj());
    expect(tables.advertising_campaigns[0]).toMatchObject({ payment_status: "paid", status: "live" });
  });
});

describe("handleAdPaymentIntent", () => {
  const piObj = (over: Row = {}) => ({
    id: "pi_1", metadata: { kind: "ad_campaign", campaign_id: "camp_1" }, ...over,
  }) as Row & { id: string };

  it("failed PI marks only pending ledger rows failed and fails the pending campaign", async () => {
    const tables: Record<string, Row[]> = {
      advertising_campaigns: [campaign({ payment_status: "checkout_pending" })],
      ad_ledger: [{ id: "l1", campaign_id: "camp_1", kind: "charge", status: "pending", stripe_payment_intent_id: "pi_1" }],
    };
    const { db } = fakeDb(tables);
    expect(await handleAdPaymentIntent(db, piObj(), "failed")).toBe(true);
    expect(tables.ad_ledger[0].status).toBe("failed");
    expect(tables.advertising_campaigns[0].payment_status).toBe("failed");
  });

  it("succeeded PI reconciles a pending ledger row without double-counting", async () => {
    const tables: Record<string, Row[]> = {
      advertising_campaigns: [campaign({ payment_status: "checkout_pending", stripe_payment_intent_id: "pi_1" })],
      ad_ledger: [{ id: "l1", campaign_id: "camp_1", kind: "charge", status: "pending", stripe_payment_intent_id: "pi_1" }],
    };
    const { db } = fakeDb(tables);
    await handleAdPaymentIntent(db, piObj(), "succeeded");
    expect(tables.ad_ledger[0].status).toBe("succeeded");
    expect(tables.advertising_campaigns[0].payment_status).toBe("paid");
    // A second delivery finds nothing pending and changes nothing.
    await handleAdPaymentIntent(db, piObj(), "succeeded");
    expect(tables.ad_ledger).toHaveLength(1);
  });
});

describe("handleAdChargeRefunded", () => {
  const paidTables = (): Record<string, Row[]> => ({
    advertising_campaigns: [campaign({ payment_status: "paid" })],
    ad_ledger: [{ id: "l1", campaign_id: "camp_1", kind: "charge", status: "succeeded", stripe_payment_intent_id: "pi_1" }],
  });

  it("full refund marks the ledger and campaign refunded", async () => {
    const tables = paidTables();
    const { db } = fakeDb(tables);
    const charge = { id: "ch_1", payment_intent: "pi_1", amount: 70000, amount_refunded: 70000, refunds: { data: [{ id: "re_1" }] } } as Row & { id: string };
    expect(await handleAdChargeRefunded(db, charge)).toBe(true);
    expect(tables.ad_ledger[0]).toMatchObject({ status: "refunded", stripe_refund_id: "re_1" });
    expect(tables.advertising_campaigns[0].payment_status).toBe("refunded");
  });

  it("partial refund leaves ledger and campaign untouched", async () => {
    const tables = paidTables();
    const { db } = fakeDb(tables);
    const charge = { id: "ch_1", payment_intent: "pi_1", amount: 70000, amount_refunded: 1000, refunds: { data: [{ id: "re_1" }] } } as Row & { id: string };
    expect(await handleAdChargeRefunded(db, charge)).toBe(true);
    expect(tables.ad_ledger[0].status).toBe("succeeded");
    expect(tables.advertising_campaigns[0].payment_status).toBe("paid");
  });

  it("returns false for a PaymentIntent with no ad ledger rows (rental path)", async () => {
    const { db } = fakeDb({ ad_ledger: [] });
    const charge = { id: "ch_9", payment_intent: "pi_rental", amount: 700, amount_refunded: 700 } as Row & { id: string };
    expect(await handleAdChargeRefunded(db, charge)).toBe(false);
  });
});
