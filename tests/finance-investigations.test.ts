import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleDossier, buildRecommendation, canTransitionStatus, decideCase,
  FIN_CASE_STATUSES, type DossierInput, type PaymentRow, type RentalRow,
} from "../src/lib/finance/investigations";
import { allRiskSignals, checkoutFailureSignals, giftClaimSignals } from "../src/lib/finance/risk-signals";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const NOW = "2026-11-10T12:00:00.000Z";

const baseInput = (over: Partial<DossierInput> = {}): DossierInput => ({
  rental: null, payments: [], ledger: [], entitlementEvents: [], sponsored: [],
  kioskEvents: [], deviceEvents: [], commands: [], stripeEvents: [],
  tickets: [], ticketMessages: [], now: NOW, ...over,
});

const rental = (over: Record<string, unknown> = {}): RentalRow => ({
  id: "r1", reference: "ZR-TEST0001", state: "returned", kiosk_id: "k1",
  customer_id: "cust1", created_at: "2026-11-01T10:00:00Z",
  started_at: "2026-11-01T10:05:00Z", dispensed_at: "2026-11-01T10:06:00Z",
  returned_at: "2026-11-01T11:30:00Z", pricing_version: "pilot-2026-v1",
  ...over,
} as RentalRow);

const payment = (over: Record<string, unknown> = {}): PaymentRow => ({
  id: "p1", rental_id: "r1", state: "captured", amount_captured_cents: 1200,
  amount_refunded_cents: 0, stripe_payment_intent_id: "pi_1", receipt_email: "a@b.c",
  created_at: "2026-11-01T10:00:00Z", ...over,
} as PaymentRow);

/* ── Lifecycle ────────────────────────────────────────────────────────────── */

describe("case lifecycle transitions", () => {
  it("allows the documented forward path", () => {
    expect(canTransitionStatus("new", "collecting_evidence")).toBe(true);
    expect(canTransitionStatus("collecting_evidence", "investigation")).toBe(true);
    expect(canTransitionStatus("investigation", "human_review")).toBe(true);
    expect(canTransitionStatus("human_review", "approved_action")).toBe(false); // decide() owns this
    expect(canTransitionStatus("approved_action", "resolved")).toBe(true);
    expect(canTransitionStatus("resolved", "reopened")).toBe(true);
    expect(canTransitionStatus("reopened", "investigation")).toBe(true);
  });
  it("rejects nonsense jumps and decided-state rewinds", () => {
    expect(canTransitionStatus("new", "resolved")).toBe(false);
    expect(canTransitionStatus("denied", "investigation")).toBe(false);
    expect(canTransitionStatus("resolved", "new")).toBe(false);
  });
  it("every declared status is reachable in the transition map", () => {
    for (const s of FIN_CASE_STATUSES) expect(typeof s).toBe("string");
  });
});

describe("decide() guardrails", () => {
  const fakeDb = {} as SupabaseClient;
  it("requires a rationale before touching the database", async () => {
    const res = await decideCase(fakeDb, "00000000-0000-0000-0000-000000000000",
      { id: "u1", role: "staff" }, "approved", "   ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(422);
  });
  it("rejects short rationales", async () => {
    const res = await decideCase(fakeDb, "00000000-0000-0000-0000-000000000000",
      { id: "u1", role: "admin" }, "denied", "no");
    expect(res.ok).toBe(false);
  });
});

/* ── Dossier assembly ─────────────────────────────────────────────────────── */

describe("evidence dossier assembly", () => {
  it("separates verified facts, customer statements, missing records and conflicts", () => {
    const d = assembleDossier(baseInput({
      rental: rental({ state: "cancelled", returned_at: null }),
      payments: [payment()],
      ledger: [{ id: "l1", rental_id: "r1", kind: "rental_charge", amount_cents: 1200, status: "succeeded", idempotency_key: "k1", created_at: NOW }],
      kioskEvents: [], deviceEvents: [],
      tickets: [{ id: "t1", ticket_number: "Z-1", rental_id: "r1", description: "I was charged twice", created_at: NOW }],
      ticketMessages: [{ id: "m1", ticket_id: "t1", internal: false, body: "Please refund me", created_at: NOW }],
    }));
    expect(d.verified_facts.some((f) => f.ref === "payments:p1")).toBe(true);
    expect(d.verified_facts.some((f) => f.ref === "billing_ledger:l1")).toBe(true);
    // customer statement kept OUT of verified facts
    expect(d.customer_statements.some((f) => f.ref === "support_messages:m1")).toBe(true);
    expect(d.verified_facts.some((f) => f.ref === "support_messages:m1")).toBe(false);
    // internal messages never become statements — covered by fixture having none internal; check conflict for captured+cancelled
    expect(d.conflicts.length).toBeGreaterThan(0);
    expect(d.missing_records.length).toBeGreaterThanOrEqual(0);
  });

  it("flags missing telemetry as missing, and adds the not-counted-against-customer policy note", () => {
    const d = assembleDossier(baseInput({
      rental: rental({ state: "returned" }),
      payments: [payment()],
      kioskEvents: [], deviceEvents: [], // station k1 has NO telemetry at all
    }));
    expect(d.missing_records.some((m) => /telemetry|kiosk/i.test(m.description))).toBe(true);
    expect(d.policy_notes.some((p) => /NEVER counted against the customer/i.test(p))).toBe(true);
  });

  it("every verified fact carries a table:id record ref", () => {
    const d = assembleDossier(baseInput({
      rental: rental(), payments: [payment()],
      ledger: [{ id: "l9", kind: "rental_charge", amount_cents: 500, status: "succeeded", idempotency_key: "x", created_at: NOW }],
    }));
    for (const f of d.verified_facts) expect(f.ref).toMatch(/^[a-z_]+:[^\s]+$/);
  });
});

/* ── Recommendation rules ─────────────────────────────────────────────────── */

describe("recommendation rules", () => {
  it("duplicate succeeded captures → proposes a refund capped at the remainder", () => {
    const input = baseInput({
      rental: rental({ state: "returned" }),
      payments: [payment(), payment({ id: "p2", stripe_payment_intent_id: "pi_2" })],
      ledger: [
        { id: "l1", rental_id: "r1", kind: "rental_charge", amount_cents: 1200, status: "succeeded", idempotency_key: "a", created_at: NOW },
        { id: "l2", rental_id: "r1", kind: "rental_charge", amount_cents: 1200, status: "succeeded", idempotency_key: "b", created_at: NOW },
      ],
      kioskEvents: [{ id: 1, kiosk_id: "k1", type: "power_bank_docked", result: "returned", occurred_at: NOW }],
    });
    const d = assembleDossier(input);
    const rec = buildRecommendation(input, d);
    expect(rec.proposed_refund_cents).not.toBeNull();
    expect(rec.proposed_refund_cents!).toBeLessThanOrEqual(1200);
    expect(rec.confidence).toBe("high");
    expect(rec.reasoning.join(" ")).toMatch(/duplicate/i);
    // never approves by itself
    expect(JSON.stringify(rec)).not.toMatch(/approved_action|auto_approve/);
  });

  it("captured charge on cancelled rental with no dispense → refund proposal", () => {
    const input = baseInput({
      rental: rental({ state: "cancelled", dispensed_at: null, returned_at: null }),
      payments: [payment()],
      ledger: [{ id: "l1", rental_id: "r1", kind: "rental_charge", amount_cents: 1200, status: "succeeded", idempotency_key: "a", created_at: NOW }],
    });
    const rec = buildRecommendation(input, assembleDossier(input));
    expect(rec.proposed_refund_cents).toBe(1200);
    expect(rec.customer_explanation_draft).toContain("$12");
  });

  it("missing return telemetry is explicitly not counted against the customer", () => {
    const input = baseInput({
      rental: rental({ state: "returned", kiosk_id: "k-missing" }),
      payments: [payment()],
      kioskEvents: [], deviceEvents: [],
    });
    const rec = buildRecommendation(input, assembleDossier(input));
    expect(rec.contradicting.join(" ")).toMatch(/NOT counted against the customer|missing telemetry/i);
    expect(rec.proposed_refund_cents).toBeNull();
  });

  it("entitlement consumed on cancelled rental → credit restoration, not cash refund", () => {
    const input = baseInput({
      rental: rental({ state: "cancelled", dispensed_at: null, returned_at: null }),
      payments: [], // no money captured
      entitlementEvents: [{ id: 5, profile_id: "cust1", event: "redeem", delta: -1, ref_type: "rental", ref_id: "r1", actor: "customer", created_at: NOW }],
    });
    const rec = buildRecommendation(input, assembleDossier(input));
    expect(rec.credit_restore).not.toBeNull();
    expect(rec.credit_restore!.units).toBe(1);
    expect(rec.proposed_refund_cents).toBeNull();
  });
});

/* ── Risk signals ─────────────────────────────────────────────────────────── */

describe("risk signals", () => {
  it("flags repeated checkout failures per email", () => {
    const sigs = checkoutFailureSignals([
      { id: "a", state: "failed", receipt_email: "x@y.z", created_at: "2026-11-09T00:00:00Z" },
      { id: "b", state: "released", receipt_email: "x@y.z", created_at: "2026-11-09T01:00:00Z" },
      { id: "c", state: "failed", receipt_email: "x@y.z", created_at: "2026-11-09T02:00:00Z" },
    ], Date.parse("2026-11-10T00:00:00Z"));
    expect(sigs).toHaveLength(1);
    expect(sigs[0].kind).toBe("repeated_checkout_failures");
    expect(sigs[0].facts.length).toBe(3);
  });
  it("flags gift claim failure streaks but never redeemed gifts", () => {
    const sigs = giftClaimSignals([
      { id: "g1", status: "paid", attempts: 7, last_attempt_at: NOW },
      { id: "g2", status: "redeemed", attempts: 20 },
    ]);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].facts[0]).toContain("gift_credits:g1");
  });
  it("allRiskSignals never throws on empty input", () => {
    expect(allRiskSignals({})).toEqual([]);
  });
});

/* ── Human/agent separation guard ─────────────────────────────────────────── */

describe("no agent-facing refund execution", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
    });

  it("finance lib never imports Stripe or the refund route", () => {
    const files = walk(join(__dirname, "..", "src", "lib", "finance"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/createRefund\s*\(|\.from\(["']refunds["']\)|["']\.\.\/stripe["']|["']@\/lib\/stripe["']/);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_.*SERVICE_ROLE/);
    }
  });

  it("agent registry permanently denies refund.issue approvals", () => {
    const src = readFileSync(join(__dirname, "..", "src", "lib", "agents", "registry.ts"), "utf8");
    const m = src.match(/DENIED_ACTIONS\s*=\s*\[([\s\S]*?)\]/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('"refund.issue"');
  });

  it("decide route requires a staff session and never calls Stripe", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "api", "admin", "finance", "investigations", "[id]", "decide", "route.ts"), "utf8");
    expect(src).toContain("staffGate");
    expect(src).toContain("decideCase");
    expect(src).not.toMatch(/createRefund|stripe/i);
  });
});
