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
import { NotConfiguredRefundProvider } from "@/lib/payments/source";

const NOW = new Date("2026-11-10T12:00:00Z");
const mkCtx = (repo = new MemoryRepo()): svc.Ctx => ({
  repo, chat: null, mailer: null, rentals: new DemoRentalDirectory(),
  refunds: new NotConfiguredRefundProvider(), now: () => NOW, siteUrl: "https://z.test",
});

const SECRET = "test-inbound-secret";
const post = (payload: unknown, opts: { key?: string; form?: boolean; auth?: string } = {}) => {
  const headers: Record<string, string> = {};
  let body: BodyInit;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(payload as Record<string, string>).toString();
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
  }
  if (opts.key !== undefined) headers["x-test-key"] = "";
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
  return { ctx, number: ticket.number };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  dbHolder.db = null;
});

describe("inbound email webhook", () => {
  it("503 when EMAIL_INBOUND_SECRET is not configured", async () => {
    delete process.env.EMAIL_INBOUND_SECRET;
    const res = await post({ from: "a@b.com", subject: "[Z-1] hi", text: "yo" }, { key: SECRET });
    expect(res.status).toBe(503);
  });

  it("401 on bad key, accepts ?key= or Bearer", async () => {
    expect((await post({ from: "a@b.com", subject: "x", text: "y" }, { key: "wrong" })).status).toBe(401);
    const { number } = await makeTicket();
    const ok1 = await post({ from: "pat@example.com", subject: `[${number}] hi`, text: "update?" }, { key: SECRET });
    expect(ok1.status).toBe(200);
    const ok2 = await post({ from: "pat@example.com", subject: `[${number}] hi2`, text: "more?" }, { auth: `Bearer ${SECRET}` });
    expect(ok2.status).toBe(200);
  });

  it("adds a customer reply to the matching ticket", async () => {
    const { ctx, number } = await makeTicket();
    const res = await post(
      { from: "Pat Smith <pat@example.com>", subject: `Re: [${number}] Where do I return`, text: "Any update on this?" },
      { key: SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ticket: number });
    const messages = await ctx.repo.listMessages((await ctx.repo.getTicketByNumber(number))!.id);
    expect(messages.at(-1)).toMatchObject({ authorType: "customer", body: "Any update on this?" });
  });

  it("ignores mail from a non-requester address", async () => {
    const { number } = await makeTicket();
    const res = await post({ from: "evil@example.com", subject: `[${number}] hi`, text: "inject" }, { key: SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: "forbidden" });
  });

  it("ignores mail with no ticket reference or unknown ticket", async () => {
    await makeTicket();
    expect(await (await post({ from: "pat@example.com", subject: "hello", text: "hi" }, { key: SECRET })).json()).toMatchObject({ ignored: "no_ticket_reference" });
    expect(await (await post({ from: "pat@example.com", subject: "[Z-999] hi", text: "hi" }, { key: SECRET })).json()).toMatchObject({ ignored: "unknown_ticket" });
  });

  it("accepts Brevo-style capitalized form fields and strips quoted text", async () => {
    const { ctx, number } = await makeTicket();
    const res = await post(
      { From: "pat@example.com", Subject: `[${number}] Re:`, Text: "Here is my answer.\n\n> previous message\n> quoted stuff" },
      { key: SECRET, form: true },
    );
    expect(res.status).toBe(200);
    const messages = await ctx.repo.listMessages((await ctx.repo.getTicketByNumber(number))!.id);
    expect(messages.at(-1)!.body).toBe("Here is my answer.");
    expect(ctx).toBeTruthy();
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
