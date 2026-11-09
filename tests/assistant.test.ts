import { beforeEach, describe, expect, it, vi } from "vitest";
import { chicagoToUtc, containsCardNumber, runAssistant, type UserTurn } from "@/lib/ai/assistant";
import { buildSystemPrompt, contextFor } from "@/lib/ai/knowledge";
import type { ChatFn, ChatMessage } from "@/lib/ai/openrouter";
import { NotConfiguredPaymentSource } from "@/lib/payments/source";
import { fmt, PRICING_V1 } from "@/lib/pricing";
import { describeRental, type RentalRow, type RentalResult } from "@/lib/rental-lookup";
import { lookupRentals } from "@/lib/rental-service";
import { resetRateLimits } from "@/lib/rate-limit";

const P = PRICING_V1;
const U = (content: string): UserTurn => ({ role: "user", content });
const call = (name: string, args: object, id = "c1") => ({ content: null, tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });

const RESULT = { reference: "ZR-1A2B3C4D", status: "Returned" } as RentalResult;
/** Scripted model: replays the given responses in order, recording what it was sent. */
function scripted(...responses: Awaited<ReturnType<ChatFn>>[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async ({ messages }) => { seen.push(structuredClone(messages)); return responses[Math.min(i++, responses.length - 1)]; };
  return { chat, seen };
}

beforeEach(() => resetRateLimits());

describe("grounding", () => {
  const sys = buildSystemPrompt();
  it("embeds every price and window from the pricing config", () => {
    for (const c of [P.firstHourCents, P.additionalHourCents, P.first24hCapCents, P.nonReturnMaxCents]) expect(sys).toContain(fmt(c));
    expect(sys).toContain(`${P.nonReturnAfterHours} hours`);
    expect(sys.toLowerCase()).toContain("proposed pilot");
  });
  it("forbids inventing facts, promising refunds, sharing partner terms, and taking card data", () => {
    for (const rule of ["Never invent", "Never promise, approve, deny or issue a refund", "revenue shares", "card numbers"]) expect(sys).toContain(rule);
  });
  it("states there are no live stations while the station list is empty", () => {
    expect(sys).toContain("NO live stations");
  });
  it("retrieves relevant articles for the question", () => {
    expect(contextFor("how do refunds work")).toMatch(/refund/i);
    expect(contextFor("zzzzqqqq")).toBeNull();
  });
});

describe("assistant orchestration", () => {
  it("injects retrieved help content as a system message before the model answers", async () => {
    const { chat, seen } = scripted({ content: "ok" });
    await runAssistant({ messages: [U("What is the non-return charge?")], ip: "1.1.1.1", chat });
    const sys = seen[0].filter((m) => m.role === "system");
    expect(sys.length).toBe(2);
    expect(String(sys[1].content)).toContain("Relevant help articles");
  });

  it("refuses a lookup when the model uses an email the customer never typed", async () => {
    const lookup = vi.fn();
    const { chat } = scripted(call("lookup_rental", { email: "victim@example.com", reference: "ZR-1A2B3C4D" }), { content: "done" });
    const r = await runAssistant({ messages: [U("check my rental")], ip: "1.1.1.1", chat, lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.rentals).toEqual([]);
  });

  it("looks up by reference with the customer's own email and returns the cards", async () => {
    const lookup = vi.fn().mockResolvedValue({ status: "ok", results: [RESULT] });
    const { chat, seen } = scripted(call("lookup_rental", { email: "Pat@Example.com", reference: "zr-1a2b3c4d" }), { content: "Here's what I found." });
    const r = await runAssistant({ messages: [U("my email is pat@example.com and ref zr-1a2b3c4d")], ip: "9.9.9.9", chat, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toMatchObject({ email: "pat@example.com", reference: "ZR-1A2B3C4D" });
    expect(lookup.mock.calls[0][1]).toBe("9.9.9.9");
    expect(r.rentals).toEqual([RESULT]);
    expect(r.reply).toBe("Here's what I found.");
    expect(seen[1].some((m) => m.role === "tool")).toBe(true);
  });

  it("builds a Minnesota-time date window (<=48h) for date lookups", async () => {
    const lookup = vi.fn().mockResolvedValue({ status: "not_found" });
    const { chat } = scripted(call("lookup_rental", { email: "pat@example.com", date: "2026-11-08", time: "12:00", station: "Riverside" }), { content: "No match." });
    await runAssistant({ messages: [U("pat@example.com rented around noon on 2026-11-08 at Riverside")], ip: "x", chat, lookup });
    const q = lookup.mock.calls[0][0];
    expect(q.from).toBe("2026-11-08T15:00:00.000Z"); // 12:00 CST (UTC-6) = 18:00Z, minus 3h
    expect(q.to).toBe("2026-11-08T21:00:00.000Z");
    expect(q.station).toBe("Riverside");
  });

  it("rejects malformed references and missing date/reference without calling lookup", async () => {
    const lookup = vi.fn();
    const { chat } = scripted(call("lookup_rental", { email: "pat@example.com", reference: "nope" }), call("lookup_rental", { email: "pat@example.com" }, "c2"), { content: "Need more info." });
    const r = await runAssistant({ messages: [U("pat@example.com")], ip: "x", chat, lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.reply).toBe("Need more info.");
  });

  it("falls back to a safe message if the model loops on tools", async () => {
    const { chat } = scripted(call("search_help_articles", { query: "refund" }));
    const r = await runAssistant({ messages: [U("refund?")], ip: "x", chat });
    expect(r.reply).toMatch(/\/support\/new/);
  });

  it("flags card-like text so the route can block it before the model", () => {
    expect(containsCardNumber([U("my card is 4242 4242 4242 4242")])).toBe(true);
    expect(containsCardNumber([U("ref ZR-1A2B3C4D")])).toBe(false);
  });

  it("converts Chicago wall-clock time to UTC across DST", () => {
    expect(chicagoToUtc("2026-11-08", "12:00").toISOString()).toBe("2026-11-08T18:00:00.000Z"); // CST
    expect(chicagoToUtc("2026-07-01", "12:00").toISOString()).toBe("2026-07-01T17:00:00.000Z"); // CDT
  });
});

describe("rental service + Stripe seam", () => {
  const dbRow = (): RentalRow => ({
    reference: "ZR-1A2B3C4D", state: "returned", started_at: "2026-11-08T18:00:00Z", dispensed_at: "2026-11-08T18:00:00Z", returned_at: "2026-11-08T20:30:00Z", non_return_deadline: null,
    kiosks: { station_id: "ZP-001", venues: { name: "Riverside Tavern", city: "St. Cloud" } },
    payments: [{ state: "captured", amount_captured_cents: 1299, amount_refunded_cents: 0, stripe_payment_intent_id: "pi_123" }],
  });
  const fakeDb = (rows: RentalRow[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "gte", "lte", "order", "limit"]) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    return chain as never;
  };
  const q = { email: "pat@example.com", reference: "ZR-1A2B3C4D" } as never;

  it("reports unconfigured when no database is linked", async () => {
    expect((await lookupRentals(q, "ip", { db: null })).status).toBe("unconfigured");
  });
  it("returns not_found for empty results", async () => {
    expect((await lookupRentals(q, "ip", { db: fakeDb([]) })).status).toBe("not_found");
  });
  it("uses database values when Stripe isn't linked", async () => {
    const out = await lookupRentals(q, "ip", { db: fakeDb([dbRow()]), payments: new NotConfiguredPaymentSource() });
    expect(out.status === "ok" && out.results[0].chargedCents).toBe(1299);
  });
  it("overlays live Stripe capture/refund data when a PaymentSource is linked", async () => {
    const payments = { summarize: vi.fn().mockResolvedValue({ status: "succeeded", capturedCents: 1099, refundedCents: 1099 }) };
    const out = await lookupRentals(q, "ip", { db: fakeDb([dbRow()]), payments });
    expect(payments.summarize).toHaveBeenCalledWith("pi_123");
    if (out.status !== "ok") throw new Error("expected ok");
    expect(out.results[0]).toMatchObject({ chargedCents: 1099, refundedCents: 1099, suggestRefund: false });
    expect(out.results[0].explanation).toMatch(/fully refunded/i);
  });
  it("keeps the database value if Stripe errors", async () => {
    const payments = { summarize: vi.fn().mockRejectedValue(new Error("stripe down")) };
    const out = await lookupRentals(q, "ip", { db: fakeDb([dbRow()]), payments });
    expect(out.status === "ok" && out.results[0].chargedCents).toBe(1299);
  });
  it("rate limits repeated lookups for the same email", async () => {
    let last = "";
    for (let i = 0; i < 8; i++) last = (await lookupRentals(q, `ip-${i}`, { db: null })).status;
    expect(last).toBe("rate_limited");
  });
  it("describeRental never leaks the PaymentIntent id", () => {
    expect(JSON.stringify(describeRental(dbRow()))).not.toMatch(/pi_123|stripe/i);
  });
});
