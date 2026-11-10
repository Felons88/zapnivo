import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formEncode, verifyStripeSignature } from "../src/lib/stripe";

const SECRET = "whsec_test";
const header = (payload: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("verifyStripeSignature", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_700_000_000_000;
  const t = now / 1000;
  it("accepts a valid signature", () => expect(verifyStripeSignature(body, header(body, t), SECRET, now).ok).toBe(true));
  it("rejects a wrong secret or tampered body", () => {
    expect(verifyStripeSignature(body, header(body, t, "other"), SECRET, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body + " ", header(body, t), SECRET, now).ok).toBe(false);
  });
  it("rejects missing/malformed headers", () => {
    expect(verifyStripeSignature(body, null, SECRET, now)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStripeSignature(body, "garbage", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStripeSignature(body, `t=${t},v1=abc`, SECRET, now).ok).toBe(false);
  });
  it("enforces the 5 minute window", () => {
    expect(verifyStripeSignature(body, header(body, t - 301), SECRET, now)).toEqual({ ok: false, reason: "stale" });
    expect(verifyStripeSignature(body, header(body, t + 301), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, header(body, t - 299), SECRET, now).ok).toBe(true);
  });
});

describe("formEncode", () => {
  it("encodes nested keys the Stripe way", () => {
    expect(formEncode({ a: 1, b: { c: "x y" }, d: [{ e: 2 }] }).join("&")).toBe("a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=2");
  });
});

describe("webhook route", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock("../src/lib/supabase"); vi.doUnmock("../src/lib/email-triggers"); });

  function setup() {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    const seen = new Set<string>();
    const updates: { table: string; patch: unknown }[] = [];
    let failWriteTable: string | null = null;
    const db = {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.insert = async (row: { id: string }) => {
          if (table !== "stripe_events") return { error: null };
          if (seen.has(row.id)) return { error: { code: "23505" } };
          seen.add(row.id); return { error: null };
        };
        q.update = (patch: unknown) => {
          updates.push({ table, patch });
          q.then = (resolve: (value: unknown) => void) => resolve({ error: table === failWriteTable ? { message: "db unavailable" } : null });
          return q;
        };
        q.select = () => q; q.eq = () => q; q.in = () => q;
        q.delete = () => {
          q.eq = (column: string, id: string) => { if (table === "stripe_events" && column === "id") seen.delete(id); return q; };
          return q;
        };
        q.maybeSingle = async () => ({ data: null });
        q.upsert = async () => ({ error: null });
        return q;
      },
    };
    vi.doMock("../src/lib/supabase", () => ({ serviceClient: () => db }));
    vi.doMock("../src/lib/email-triggers", () => ({ triggerPaymentReceipt: async () => true, triggerPaymentFailed: async () => true }));
    return { updates, failWritesFor: (table: string | null) => { failWriteTable = table; } };
  }
  const req = (payload: string, sig: string) => new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig }, body: payload });
  const evt = (id: string, type: string, object: Record<string, unknown> = { id: "pi_1" }) => JSON.stringify({ id, type, data: { object } });
  const now = () => Math.floor(Date.now() / 1000);

  it("rejects bad signatures and stale timestamps with 400", async () => {
    setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_a", "payment_intent.succeeded");
    expect((await POST(req(p, "t=1,v1=00"))).status).toBe(400);
    expect((await POST(req(p, header(p, now() - 3600)))).status).toBe(400);
  });
  it("accepts a valid event, and dedupes a replay of the same event id", async () => {
    const { updates } = setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_b", "payment_intent.succeeded", { id: "pi_1", amount_received: 700 });
    const first = await POST(req(p, header(p, now())));
    expect(first.status).toBe(200);
    expect(updates.some((u) => u.table === "payments")).toBe(true);
    const n = updates.length;
    const second = await POST(req(p, header(p, now())));
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(updates.length).toBe(n);
  });
  it("returns 500 and permits a retry when payment reconciliation fails", async () => {
    const { failWritesFor } = setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_retry", "payment_intent.succeeded", { id: "pi_1", amount_received: 700 });
    failWritesFor("payments");
    expect((await POST(req(p, header(p, now())))).status).toBe(500);
    failWritesFor(null);
    expect((await POST(req(p, header(p, now())))).status).toBe(200);
  });
  it("answers 200 ignored for unknown events", async () => {
    setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_c", "customer.created");
    const res = await POST(req(p, header(p, now())));
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe("customer.created");
  });
  it("503 when the webhook secret is not configured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    expect((await POST(req("{}", "x"))).status).toBe(503);
  });

  it("reconciles a succeeded non_return_fee PI against billing_ledger, never payments", async () => {
    const { updates } = setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_fee_ok", "payment_intent.succeeded", {
      id: "pi_fee", amount_received: 4500, latest_charge: "ch_fee", status: "succeeded",
      metadata: { rental_id: "r1", kind: "non_return_fee" },
    });
    const res = await POST(req(p, header(p, now())));
    expect(res.status).toBe(200);
    expect(updates.some((u) => u.table === "billing_ledger" && (u.patch as { status?: string }).status === "succeeded")).toBe(true);
    expect(updates.some((u) => u.table === "rentals" && (u.patch as { non_return_fee_status?: string }).non_return_fee_status === "charged")).toBe(true);
    expect(updates.some((u) => u.table === "payments")).toBe(false);
  });

  it("marks a failed non_return_fee PI in the ledger without failing the rental payment", async () => {
    const { updates } = setup();
    const { POST } = await import("../src/app/api/webhooks/stripe/route");
    const p = evt("evt_fee_bad", "payment_intent.payment_failed", {
      id: "pi_fee", status: "requires_payment_method",
      metadata: { rental_id: "r1", kind: "non_return_fee" },
      last_payment_error: { code: "card_declined", decline_code: "generic_decline" },
    });
    const res = await POST(req(p, header(p, now())));
    expect(res.status).toBe(200);
    expect(updates.some((u) => u.table === "billing_ledger" && (u.patch as { status?: string }).status === "failed")).toBe(true);
    expect(updates.some((u) => u.table === "rentals" && (u.patch as { non_return_fee_status?: string }).non_return_fee_status === "failed")).toBe(true);
    expect(updates.some((u) => u.table === "payments")).toBe(false);
  });
});
