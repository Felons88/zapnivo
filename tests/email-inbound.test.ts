import { beforeEach, describe, expect, it, vi } from "vitest";

const { ctxHolder, dbHolder } = vi.hoisted(() => ({
  ctxHolder: { ctx: null as unknown },
  dbHolder: { db: null as unknown },
}));

vi.mock("@/lib/helpdesk/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/helpdesk/service")>();
  return { ...mod, defaultCtx: async () => ctxHolder.ctx };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => dbHolder.db }));

import { POST } from "@/app/api/webhooks/email/inbound/route";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { DemoRentalDirectory } from "@/lib/helpdesk/rentals";
import * as svc from "@/lib/helpdesk/service";
import { replyToken, ticketReplyAddress } from "@/lib/email/inbound";
import { NotConfiguredRefundProvider } from "@/lib/payments/source";

const NOW = new Date("2026-11-10T12:00:00Z");
const mkCtx = (repo = new MemoryRepo()): svc.Ctx => ({
  repo, chat: null, mailer: null, rentals: new DemoRentalDirectory(),
  refunds: new NotConfiguredRefundProvider(), now: () => NOW, siteUrl: "https://z.test",
});

const SECRET = "test-inbound-secret";
const post = (payload: unknown, opts: { key?: string; form?: boolean; auth?: string; header?: string; len?: number } = {}) => {
  const headers: Record<string, string> = {};
  let body: BodyInit;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(payload as Record<string, string>).toString();
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
  }
  if (opts.len) headers["content-length"] = String(opts.len);
  if (opts.header) headers["x-zapnivo-inbound-key"] = opts.header;
  const url = `http://localhost/api/webhooks/email/inbound${opts.key !== undefined ? `?key=${opts.key}` : ""}`;
  if (opts.auth) headers.authorization = opts.auth;
  return POST(new Request(url, { method: "POST", headers, body }));
};

async function makeTicket(email = "pat@example.com") {
  const ctx = mkCtx();
  ctxHolder.ctx = ctx;
  const { ticket } = await svc.createTicket(ctx, {
    requesterType: "customer", name: "Pat Smith", email,
    category: "Other", description: "Where do I return my charger?",
  });
  return { ctx, number: ticket.number, email };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  dbHolder.db = null;
});

describe("inbound email webhook — auth", () => {
  it("503 when EMAIL_INBOUND_SECRET is not configured", async () => {
    delete process.env.EMAIL_INBOUND_SECRET;
    const res = await post({ from: "a@b.com", subject: "[Z-1] hi", text: "yo" }, { key: SECRET });
    expect(res.status).toBe(503);
  });

  it("401 on bad key; accepts ?key=, Bearer, and X-Zapnivo-Inbound-Key", async () => {
    expect((await post({ from: "a@b.com", subject: "x", text: "y" }, { key: "wrong" })).status).toBe(401);
    const { number } = await makeTicket();
    expect((await post({ from: "pat@example.com", subject: `[${number}] a`, text: "1" }, { key: SECRET })).status).toBe(200);
    expect((await post({ from: "pat@example.com", subject: `[${number}] b`, text: "2" }, { auth: `Bearer ${SECRET}` })).status).toBe(200);
    expect((await post({ from: "pat@example.com", subject: `[${number}] c`, text: "3" }, { header: SECRET })).status).toBe(200);
  });

  it("supports comma-separated secrets for rotation", async () => {
    process.env.EMAIL_INBOUND_SECRET = "new-secret,old-secret";
    const { number } = await makeTicket();
    expect((await post({ from: "pat@example.com", subject: `[${number}] a`, text: "1" }, { key: "old-secret" })).status).toBe(200);
    expect((await post({ from: "pat@example.com", subject: `[${number}] b`, text: "2" }, { key: "new-secret" })).status).toBe(200);
    expect((await post({ from: "pat@example.com", subject: `[${number}] c`, text: "3" }, { key: "wrong" })).status).toBe(401);
  });

  it("413 on oversized payloads", async () => {
    const res = await post({ from: "a@b.com", subject: "x", text: "y" }, { key: SECRET, len: 3_000_000 });
    expect(res.status).toBe(413);
  });
});

describe("inbound email webhook — reply tokens", () => {
  it("accepts a reply carrying a valid plus-address token", async () => {
    const { ctx, number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const res = await post(
      { from: email, to: `support+${number}-${token}@zapnivo.com`, subject: "Re: your ticket", text: "Token reply works" },
      { key: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ticket: number });
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)).toMatchObject({ authorType: "customer", body: "Token reply works" });
  });

  it("ticket emails now carry a per-ticket Reply-To token address", async () => {
    const { number, email } = await makeTicket();
    const addr = ticketReplyAddress({ number, email, orgId: null, requesterType: "customer" })!;
    expect(addr).toMatch(/^support\+Z-\d+-[a-f0-9]{20}@zapnivo\.com$/);
  });

  it("quarantines a forged token", async () => {
    const { number } = await makeTicket();
    const res = await post(
      { from: "pat@example.com", to: `support+${number}-${"0".repeat(20)}@zapnivo.com`, subject: "hi", text: "forged" },
      { key: SECRET },
    );
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, ignored: "bad_reply_token" });
  });

  it("quarantines token-valid mail from a different sender", async () => {
    const { number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const res = await post(
      { from: "attacker@example.com", to: `support+${number}-${token}@zapnivo.com`, subject: "hi", text: "spoofed sender" },
      { key: SECRET },
    );
    expect(await res.json()).toMatchObject({ ignored: "sender_mismatch" });
  });

  it("token for one ticket cannot post to another", async () => {
    const a = await makeTicket("a@example.com");
    const b = await makeTicket("b@example.com");
    const tokenA = replyToken(a.number, a.email, null)!;
    const res = await post(
      { from: "a@example.com", to: `support+${b.number}-${tokenA}@zapnivo.com`, subject: "hi", text: "cross-ticket" },
      { key: SECRET },
    );
    expect(await res.json()).toMatchObject({ ignored: "bad_reply_token" });
  });
});

describe("inbound email webhook — legacy + edge cases", () => {
  it("adds a customer reply via legacy subject+sender match", async () => {
    const { ctx, number } = await makeTicket();
    const res = await post(
      { from: "Pat Smith <pat@example.com>", subject: `Re: [${number}] Where do I return`, text: "Any update on this?" },
      { key: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ticket: number });
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)).toMatchObject({ authorType: "customer", body: "Any update on this?" });
  });

  it("ignores mail from a non-requester address", async () => {
    const { number } = await makeTicket();
    const res = await post({ from: "evil@example.com", subject: `[${number}] hi`, text: "inject" }, { key: SECRET });
    expect(await res.json()).toMatchObject({ ignored: "forbidden" });
  });

  it("ignores mail with no ticket reference or unknown ticket", async () => {
    await makeTicket();
    expect(await (await post({ from: "pat@example.com", subject: "hello", text: "hi" }, { key: SECRET })).json()).toMatchObject({ ignored: "no_ticket_reference" });
    expect(await (await post({ from: "pat@example.com", subject: "[Z-999] hi", text: "hi" }, { key: SECRET })).json()).toMatchObject({ ignored: "unknown_ticket" });
  });

  it("quarantines on DMARC fail when provider reports it", async () => {
    const { number } = await makeTicket();
    const res = await post(
      { from: "pat@example.com", subject: `[${number}] hi`, text: "body", "authentication-results": "mx.google.com; dmarc=fail header.from=example.com" },
      { key: SECRET },
    );
    expect(await res.json()).toMatchObject({ ignored: "dmarc_fail" });
  });

  it("accepts Brevo-style capitalized form fields and strips quoted text", async () => {
    const { ctx, number } = await makeTicket();
    const res = await post(
      { From: "pat@example.com", Subject: `[${number}] Re:`, Text: "Here is my answer.\n\n> previous message\n> quoted stuff" },
      { key: SECRET, form: true },
    );
    expect(res.status).toBe(200);
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)!.body).toBe("Here is my answer.");
  });

  it("falls back to html body when no text part", async () => {
    const { number } = await makeTicket();
    const res = await post(
      { from: "pat@example.com", subject: `[${number}] hi`, html: "<p>HTML <b>reply</b> here</p>" },
      { key: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ticket: number });
  });
});
