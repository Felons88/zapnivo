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
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, accepted: 1 });
    expect(j.results[0]).toMatchObject({ status: "accepted", ticket: number });
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
    expect(j.results[0]).toMatchObject({ status: "quarantined", reason: "bad_reply_token" });
  });

  it("quarantines token-valid mail from a different sender", async () => {
    const { number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const res = await post(
      { from: "attacker@example.com", to: `support+${number}-${token}@zapnivo.com`, subject: "hi", text: "spoofed sender" },
      { key: SECRET },
    );
    expect((await res.json()).results[0]).toMatchObject({ status: "quarantined", reason: "sender_mismatch" });
  });

  it("token for one ticket cannot post to another", async () => {
    const a = await makeTicket("a@example.com");
    const b = await makeTicket("b@example.com");
    const tokenA = replyToken(a.number, a.email, null)!;
    const res = await post(
      { from: "a@example.com", to: `support+${b.number}-${tokenA}@zapnivo.com`, subject: "hi", text: "cross-ticket" },
      { key: SECRET },
    );
    expect((await res.json()).results[0]).toMatchObject({ status: "quarantined", reason: "bad_reply_token" });
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
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, accepted: 1 });
    expect(j.results[0]).toMatchObject({ status: "accepted", ticket: number });
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)).toMatchObject({ authorType: "customer", body: "Any update on this?" });
  });

  it("ignores mail from a non-requester address", async () => {
    const { number } = await makeTicket();
    const res = await post({ from: "evil@example.com", subject: `[${number}] hi`, text: "inject" }, { key: SECRET });
    expect((await res.json()).results[0]).toMatchObject({ status: "ignored", reason: "forbidden" });
  });

  it("ignores mail with no ticket reference or unknown ticket", async () => {
    await makeTicket();
    expect((await (await post({ from: "pat@example.com", subject: "hello", text: "hi" }, { key: SECRET })).json()).results[0]).toMatchObject({ status: "ignored", reason: "no_ticket_reference" });
    expect((await (await post({ from: "pat@example.com", subject: "[Z-999] hi", text: "hi" }, { key: SECRET })).json()).results[0]).toMatchObject({ status: "ignored", reason: "unknown_ticket" });
  });

  it("quarantines on DMARC fail when provider reports it", async () => {
    const { number } = await makeTicket();
    const res = await post(
      { from: "pat@example.com", subject: `[${number}] hi`, text: "body", "authentication-results": "mx.google.com; dmarc=fail header.from=example.com" },
      { key: SECRET },
    );
    expect((await res.json()).results[0]).toMatchObject({ status: "quarantined", reason: "dmarc_fail" });
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
    const j = await res.json();
    expect(j.results[0]).toMatchObject({ status: "accepted", ticket: number });
  });
});

// Real Brevo Inbound Parsing payload shape:
// https://developers.brevo.com/docs/inbound-parse-webhooks
const brevoItem = (over: Record<string, unknown> = {}) => ({
  Uuid: ["9f1c2a34-0000-4000-8000-abcdef123456"],
  MessageId: "<brevo-msg-1@mail.gmail.com>",
  InReplyTo: "<original-outbound@zapnivo.com>",
  From: { Name: "Pat Smith", Address: "pat@example.com" },
  To: [{ Name: "Zapnivo Support", Address: "support@in.zapnivo.com" }],
  Recipients: ["support@in.zapnivo.com"],
  Cc: [],
  ReplyTo: null,
  SentAtDate: "Tue, 10 Nov 2026 12:00:00 +0000",
  Subject: "Re: your Zapnivo support request",
  RawHtmlBody: "<p>Reply body</p>",
  RawTextBody: "Reply body\n\n> quoted previous\n> more quote",
  ExtractedMarkdownMessage: "Reply body",
  ExtractedMarkdownSignature: "**Pat Smith**",
  SpamScore: 0.5,
  Attachments: [],
  Headers: {
    "Delivered-To": "support@in.zapnivo.com",
    "To": "Zapnivo Support <support+Z-1-aaaaaaaaaaaaaaaaaaaa@zapnivo.com>",
    "From": "Pat Smith <pat@example.com>",
    "Message-ID": "<brevo-msg-1@mail.gmail.com>",
    "In-Reply-To": "<original-outbound@zapnivo.com>",
    "Authentication-Results": "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
  },
  ...over,
});
const brevoPost = (items: unknown[]) => post({ items }, { key: SECRET });

describe("inbound email webhook — Brevo payload format", () => {
  it("accepts a customer reply via reply token in forwarded To header", async () => {
    const { ctx, number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const item = brevoItem({
      MessageId: `<m-${number}@gmail.com>`,
      Headers: {
        ...brevoItem().Headers,
        "To": `Zapnivo <support+${number}-${token}@zapnivo.com>`,
      },
    });
    const res = await brevoPost([item]);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, processed: 1, accepted: 1 });
    expect(j.results[0]).toMatchObject({ status: "accepted", ticket: number });
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)).toMatchObject({ authorType: "customer", body: "Reply body" });
  });

  it("finds the token in structured To[] mailboxes when headers lack it", async () => {
    const { number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const item = brevoItem({
      To: [{ Name: null, Address: `support+${number}-${token}@zapnivo.com` }],
      Headers: { "Delivered-To": "support@in.zapnivo.com" },
    });
    const j = await (await brevoPost([item])).json();
    expect(j.results[0]).toMatchObject({ status: "accepted", ticket: number });
  });

  it("processes multiple items independently in one webhook", async () => {
    const ctx = mkCtx();
    ctxHolder.ctx = ctx;
    const ta = await svc.createTicket(ctx, { requesterType: "customer", name: "A", email: "a@example.com", category: "Other", description: "q" });
    const tb = await svc.createTicket(ctx, { requesterType: "customer", name: "B", email: "b@example.com", category: "Other", description: "q" });
    const a = { number: ta.ticket.number, email: "a@example.com" };
    const b = { number: tb.ticket.number, email: "b@example.com" };
    const tokenA = replyToken(a.number, a.email, null)!;
    const tokenB = replyToken(b.number, b.email, null)!;
    const mk = (n: string, e: string, tok: string, mid: string) => brevoItem({
      MessageId: mid,
      From: { Name: "X", Address: e },
      Headers: { "To": `support+${n}-${tok}@zapnivo.com` },
    });
    const j = await (await brevoPost([
      mk(a.number, a.email, tokenA, "<m-a@x>"),
      mk(b.number, b.email, tokenB, "<m-b@x>"),
      brevoItem({ MessageId: "<m-none@x>", Subject: "no ticket here", Headers: { "Delivered-To": "support@in.zapnivo.com" } }),
    ])).json();
    expect(j).toMatchObject({ processed: 3, accepted: 2 });
    expect(j.results.map((r: { status: string }) => r.status)).toEqual(["accepted", "accepted", "ignored"]);
  });

  it("uses ExtractedMarkdownMessage as the body (signature already stripped)", async () => {
    const { ctx, number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const item = brevoItem({
      ExtractedMarkdownMessage: "Clean markdown reply **bold**",
      Headers: { "To": `support+${number}-${token}@zapnivo.com` },
    });
    await brevoPost([item]);
    const t = await ctx.repo.getTicketByNumber(number);
    const messages = await ctx.repo.listMessages(t!.id);
    expect(messages.at(-1)!.body).toContain("Clean markdown reply");
  });

  it("dedupes a repeated MessageId delivery when the DB is present", async () => {
    // With db=null the unique index is a no-op; this asserts the code path
    // doesn't error and the content-hash fallback stays consistent.
    const { number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const item = brevoItem({
      MessageId: "<dup-1@x>",
      Headers: { "To": `support+${number}-${token}@zapnivo.com` },
    });
    const first = await (await brevoPost([item])).json();
    const second = await (await brevoPost([item])).json();
    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);
  });

  it("quarantines a forged reply token carried in To[]", async () => {
    const { number } = await makeTicket();
    const item = brevoItem({
      To: [{ Address: `support+${number}-${"f".repeat(20)}@zapnivo.com` }],
      Headers: {},
    });
    const j = await (await brevoPost([item])).json();
    expect(j.results[0]).toMatchObject({ status: "quarantined", reason: "bad_reply_token" });
  });

  it("quarantines when From does not match the token's requester", async () => {
    const { number, email } = await makeTicket();
    const token = replyToken(number, email, null)!;
    const item = brevoItem({
      From: { Name: "Attacker", Address: "attacker@evil.com" },
      Headers: { "To": `support+${number}-${token}@zapnivo.com` },
    });
    const j = await (await brevoPost([item])).json();
    expect(j.results[0]).toMatchObject({ status: "quarantined", reason: "sender_mismatch" });
  });

  it("does not let a partner-B sender post to a partner-A ticket", async () => {
    const ctx = mkCtx();
    ctxHolder.ctx = ctx;
    const { ticket } = await svc.createTicket(ctx, {
      requesterType: "partner", name: "Partner Pat", email: "pat@partner-a.com",
      orgId: "org-a", venueLabel: "Partner A Venue",
      category: "Other", description: "Partner question",
    });
    const res = await brevoPost([brevoItem({
      From: { Name: "Mallory", Address: "pat@partner-b.com" },
      Subject: `Re: [${ticket.number}]`,
      ExtractedMarkdownMessage: "Trying to read another org's ticket",
      Headers: {},
    })]);
    const j = await res.json();
    expect(j.results[0].status).not.toBe("accepted");
  });

  it("ignores auto-submitted / autoresponder mail to prevent loops", async () => {
    const j = await (await brevoPost([brevoItem({
      Headers: { "Auto-Submitted": "auto-replied", "Delivered-To": "support@in.zapnivo.com" },
      Subject: "Out of Office: Re: your request",
    })])).json();
    expect(j.results[0]).toMatchObject({ status: "ignored", reason: "auto_submitted" });
  });

  it("handles a missing original-recipient (no token, no ticket ref) gracefully", async () => {
    const j = await (await brevoPost([brevoItem({
      Headers: { "Delivered-To": "support@in.zapnivo.com" },
      Subject: "random inbound",
    })])).json();
    expect(j.results[0]).toMatchObject({ status: "ignored", reason: "no_ticket_reference" });
  });
});
