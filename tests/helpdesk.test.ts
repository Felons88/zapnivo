import { describe, expect, it, vi } from "vitest";
import type { ChatFn } from "@/lib/ai/openrouter";
import { signAccess, verifyAccess } from "@/lib/helpdesk/access";
import { flushOutbox } from "@/lib/helpdesk/mailer";
import { MACROS, renderMacro } from "@/lib/helpdesk/macros";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { computeMetrics } from "@/lib/helpdesk/metrics";
import { requiresAdmin, snapshot, suggestRefund } from "@/lib/helpdesk/refund-policy";
import { DemoRentalDirectory } from "@/lib/helpdesk/rentals";
import * as svc from "@/lib/helpdesk/service";
import { dueDates, slaStatus } from "@/lib/helpdesk/sla";
import { classify, replyIsSafe, SAFETY_MESSAGE } from "@/lib/helpdesk/triage";
import { HelpdeskError, type Actor } from "@/lib/helpdesk/types";
import { NotConfiguredRefundProvider, type RefundProvider } from "@/lib/payments/source";

const NOW = new Date("2026-11-08T12:00:00Z");
const mk = (o: Partial<svc.Ctx> = {}): svc.Ctx => ({ repo: new MemoryRepo(), chat: null, mailer: null, rentals: new DemoRentalDirectory(), refunds: new NotConfiguredRefundProvider(), now: () => NOW, siteUrl: "https://z.test", ...o });
const agent: Actor = { kind: "staff", id: "agent-1", name: "Alex", role: "staff" };
const admin1: Actor = { kind: "staff", id: "admin-1", name: "Dana", role: "admin" };
const admin2: Actor = { kind: "staff", id: "admin-2", name: "Sam", role: "admin" };
const pat: Actor = { kind: "customer", email: "pat@example.com" };
const llm = (j: object): ChatFn => async () => ({ content: JSON.stringify(j) });
const GOOD = "Thanks for reaching out. Power banks are returned by docking them at any eligible participating Zapnivo station, and your rental confirmation lists where.";
const base = { requesterType: "customer" as const, name: "Pat Smith", email: "Pat@Example.com", category: "Other", description: "Where can I return my charger?" };
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof HelpdeskError ? e.code : "error"; } };

describe("classification rules", () => {
  it("routes safety language to the urgent safety queue regardless of category", () => {
    for (const t of ["my power bank is smoking", "it got very hot and swollen", "there was a spark"]) {
      const c = classify({ requesterType: "customer", category: "Other", text: t });
      expect(c).toMatchObject({ queue: "safety", priority: "urgent", safety: true, forceHuman: true });
    }
  });
  it("routes money categories to billing with a human required", () => {
    expect(classify({ requesterType: "customer", category: "Refund request", text: "refund please" })).toMatchObject({ queue: "billing", forceHuman: true });
    expect(classify({ requesterType: "customer", category: "Charger did not dispense", text: "x" }).priority).toBe("high");
  });
  it("only generic customer questions may be AI-resolved", () => {
    expect(classify({ requesterType: "customer", category: "Other", text: "where do I return it" }).forceHuman).toBe(false);
    expect(classify({ requesterType: "partner", category: "Other", text: "hi" }).forceHuman).toBe(true);
    expect(classify({ requesterType: "partner", category: "Station offline or not working", text: "dead" })).toMatchObject({ queue: "partner", priority: "high" });
  });
});

describe("reply safety guard", () => {
  it("accepts a plain helpful answer", () => expect(replyIsSafe(GOOD)).toBe(true));
  it.each([
    "We will issue you a full refund for this rental right away, thanks for your patience.",
    "Your refund has been approved and will arrive in 3 days, thanks for waiting.",
    "You will receive a refund once we confirm the station records today.",
    "We guarantee your money back within two days of this message being sent.",
    "Please email support@zapnivo.com or call 320-555-0199 for anything further today.",
    "short",
  ])("rejects %s", (t) => expect(replyIsSafe(t)).toBe(false));
});

describe("creating tickets", () => {
  it("without an AI key: honest acknowledgement, human queue, SLA clocks, signed link, email queued (not sent)", async () => {
    const c = mk();
    const { ticket, token } = await svc.createTicket(c, base);
    expect(ticket).toMatchObject({ number: "Z-1001", email: "pat@example.com", aiState: "needs_human", state: "open", queue: "customer" });
    expect(ticket.firstResponseDueAt).toBe(dueDates("normal", NOW).firstResponseDueAt);
    expect(verifyAccess(token, ticket.number)).toBe("pat@example.com");
    const msgs = await c.repo.listMessages(ticket.id);
    expect(msgs.map((m) => m.authorType)).toEqual(["customer", "system"]);
    expect(msgs[1].body).toContain("Z-1001");
    const mails = await c.repo.listEmails();
    expect(mails).toHaveLength(1);
    expect(mails[0].status).toBe("queued");
    expect(mails[0].to).toBe("pat@example.com");
  });

  it("safety reports get the static safety message and never touch the model", async () => {
    const chat = vi.fn();
    const c = mk({ chat });
    const { ticket } = await svc.createTicket(c, { ...base, category: "Damaged charger", description: "The power bank got really hot and started smoking" });
    expect(chat).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ queue: "safety", priority: "urgent", aiState: "needs_human" });
    const msgs = await c.repo.listMessages(ticket.id);
    expect(msgs[1].body).toBe(SAFETY_MESSAGE);
    expect(msgs[1].body).toContain("911");
  });

  it("a confident, safe AI answer to a generic question is sent and the ticket waits on the customer", async () => {
    const c = mk({ chat: llm({ reply: GOOD, confidence: 0.9, needs_human: false, summary: "Return question" }) });
    const { ticket } = await svc.createTicket(c, base);
    expect(ticket).toMatchObject({ aiState: "ai_active", state: "pending_customer", aiSummary: "Return question" });
    const pub = await c.repo.listMessages(ticket.id);
    expect(pub[1]).toMatchObject({ authorType: "ai", body: GOOD });
    const all = await c.repo.listMessages(ticket.id, { includeInternal: true });
    expect(all.some((m) => m.internal && m.body.includes("Summary for agent"))).toBe(true);
  });

  it("low-confidence or unsafe AI replies fall back to the static acknowledgement", async () => {
    const low = mk({ chat: llm({ reply: GOOD, confidence: 0.4, needs_human: false, summary: "x" }) });
    expect((await svc.createTicket(low, base)).ticket.aiState).toBe("needs_human");
    const bad = mk({ chat: llm({ reply: "We will issue you a full refund right now, no problem at all.", confidence: 0.99, needs_human: false, summary: "x" }) });
    const { ticket } = await svc.createTicket(bad, { ...base, category: "Refund request", description: "I want my money back" });
    const msgs = await bad.repo.listMessages(ticket.id);
    expect(msgs[1].authorType).toBe("system");
    expect(msgs[1].body).not.toMatch(/refund right now/);
  });

  it("money tickets may get an AI acknowledgement but always stay with a human", async () => {
    const reply = "Thanks for the details. I can't decide refunds myself, but our policy considers failed dispenses; a team member will check the station records for your rental.";
    const c = mk({ chat: llm({ reply, confidence: 0.9, needs_human: false, summary: "Paid, nothing dispensed" }) });
    const { ticket } = await svc.createTicket(c, { ...base, category: "Charger did not dispense", description: "Paid but nothing came out" });
    expect(ticket).toMatchObject({ queue: "billing", priority: "high", aiState: "needs_human", state: "open" });
    expect((await c.repo.listMessages(ticket.id))[1].authorType).toBe("ai");
  });

  it("survives a model that returns garbage or throws", async () => {
    for (const chat of [(async () => ({ content: "not json" })) as ChatFn, (async () => { throw new Error("down"); }) as ChatFn]) {
      const c = mk({ chat });
      const { ticket } = await svc.createTicket(c, base);
      expect(ticket.aiState).toBe("needs_human");
      expect((await c.repo.listMessages(ticket.id))[1].authorType).toBe("system");
    }
  });
});

describe("replies and access control", () => {
  it("customer follow-up on an AI ticket gets an AI answer; after 3 AI turns it hands off to a person", async () => {
    const c = mk({ chat: llm({ reply: GOOD, confidence: 0.9, needs_human: false, summary: "s" }) });
    const { ticket } = await svc.createTicket(c, base);
    await svc.requesterMessage(c, pat, ticket.number, "ok and what about hotels?");
    await svc.requesterMessage(c, pat, ticket.number, "and bars?");
    const t3 = await svc.requesterMessage(c, pat, ticket.number, "and campuses?");
    expect(t3.aiState).toBe("needs_human");
    expect(t3.state).toBe("open");
  });

  it("only the owning customer (by email) can read or write a thread", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, base);
    const other: Actor = { kind: "customer", email: "eve@example.com" };
    expect(await code(svc.getRequesterThread(c, other, ticket.number))).toBe("forbidden");
    expect(await code(svc.requesterMessage(c, other, ticket.number, "hi"))).toBe("forbidden");
    expect(await code(svc.getRequesterThread(c, pat, "Z-9999"))).toBe("not_found");
    expect(await code(svc.getRequesterThread(c, { kind: "partner", id: "p", name: "P", email: "p@x.io", orgId: "o" }, ticket.number))).toBe("forbidden");
  });

  it("internal notes never reach the customer view", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, base);
    await svc.internalNote(c, agent, ticket.number, "customer is a repeat refunder, careful");
    const view = await svc.getRequesterThread(c, pat, ticket.number);
    expect(JSON.stringify(view)).not.toMatch(/repeat refunder/);
    const staff = await svc.getStaffThread(c, agent, ticket.number);
    expect(staff.messages.some((m) => m.internal)).toBe(true);
  });

  it("agent actions require staff; a reply sets first-response, ownership and human handling", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, base);
    expect(await code(svc.agentReply(c, pat, ticket.number, "hi"))).toBe("forbidden");
    expect(await code(svc.assign(c, { kind: "partner", id: "p", name: "P", email: "p@x.io", orgId: "o" }, ticket.number, "x"))).toBe("forbidden");
    const u = await svc.agentReply(c, agent, ticket.number, "Hi Pat, looking into it.");
    expect(u).toMatchObject({ aiState: "human", state: "pending_customer", assignedTo: "agent-1" });
    expect(u.firstResponseAt).not.toBeNull();
    const events = await c.repo.listEvents(ticket.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["created", "triage", "agent_reply"]));
  });

  it("customer can ask for a person and can reopen a resolved ticket by replying", async () => {
    const c = mk({ chat: llm({ reply: GOOD, confidence: 0.9, needs_human: false, summary: "s" }) });
    const { ticket } = await svc.createTicket(c, base);
    expect((await svc.requestHuman(c, pat, ticket.number)).aiState).toBe("needs_human");
    await svc.agentReply(c, agent, ticket.number, "All sorted for you.", "resolved");
    expect((await c.repo.getTicket(ticket.id))!.state).toBe("resolved");
    expect((await svc.requesterMessage(c, pat, ticket.number, "actually one more thing")).state).toBe("open");
  });

  it("priority changes recompute SLA due dates from creation time", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, base);
    const u = await svc.setPriority(c, agent, ticket.number, "urgent");
    expect(u.firstResponseDueAt).toBe(dueDates("urgent", new Date(ticket.createdAt)).firstResponseDueAt);
  });

  it("AI draft needs a configured model and flags risky wording; it never sends", async () => {
    const none = mk();
    const { ticket } = await svc.createTicket(none, base);
    expect(await code(svc.aiDraft(none, agent, ticket.number))).toBe("unavailable");
    const c = mk({ chat: async () => ({ content: "We will issue you a full refund immediately, sorry about that." }) });
    const t2 = (await svc.createTicket(c, base)).ticket;
    const before = (await c.repo.listMessages(t2.id)).length;
    const d = await svc.aiDraft(c, agent, t2.number);
    expect(d.warnings.length).toBe(1);
    expect((await c.repo.listMessages(t2.id)).length).toBe(before);
  });
});

describe("refund policy engine", () => {
  const dir = new DemoRentalDirectory();
  const snap = async (ref: string) => snapshot((await dir.byReference(ref))!);
  it("failed dispense: full captured amount when no release is recorded", async () => {
    expect(suggestRefund(await snap("ZR-DEMO0001"), "failed_dispense")).toMatchObject({ eligible: true, suggestedCents: 699 });
  });
  it("failed dispense is NOT eligible when the station released a power bank", async () => {
    expect(suggestRefund(await snap("ZR-DEMO0003"), "failed_dispense").eligible).toBe(false);
  });
  it("overcharge: refunds only the excess over the published rate", async () => {
    expect(suggestRefund(await snap("ZR-DEMO0002"), "overcharge")).toMatchObject({ eligible: true, suggestedCents: 200 }); // 1299 captured vs 1099 published (150 min)
  });
  it("needs admin above the agent limit, and for large goodwill", () => {
    expect(requiresAdmin(1299, "defective_equipment")).toBe(false);
    expect(requiresAdmin(1300, "defective_equipment")).toBe(true);
    expect(requiresAdmin(700, "goodwill")).toBe(true);
    expect(requiresAdmin(699, "goodwill")).toBe(false);
  });
});

describe("refund workflow", () => {
  const setup = async (o: Partial<svc.Ctx> = {}, ref = "ZR-DEMO0001") => {
    const c = mk(o);
    const { ticket } = await svc.createTicket(c, { ...base, category: "Charger did not dispense", description: "Paid, nothing came out", rentalRef: ref });
    return { c, t: ticket };
  };

  it("request → approve → issue (deferred without Stripe) is audited end to end", async () => {
    const { c, t } = await setup();
    const r = await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    expect(r).toMatchObject({ status: "requested", requiresAdmin: false });
    expect((await c.repo.getTicket(t.id))!.state).toBe("pending_internal");
    const ok = await svc.decideRefund(c, agent, r.id, "approve");
    expect(ok.status).toBe("approved");
    const out = await svc.issueRefund(c, agent, r.id);
    expect(out.status).toBe("deferred");
    expect((await c.repo.getRefund(r.id))!.status).toBe("approved");
    const types = (await c.repo.listEvents(t.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["refund_requested", "refund_approved", "refund_issue_deferred"]));
  });

  it("enforces policy, balance and duplicate rules", async () => {
    const { c, t } = await setup();
    expect(await code(svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-NOPE", reason: "failed_dispense", amountCents: 100 }))).toBe("not_found");
    expect(await code(svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 9999 }))).toBe("invalid"); // > balance
    expect(await code(svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "overcharge", amountCents: 100 }))).toBe("invalid");        // outside policy
    expect(await code(svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699, override: true }))).toBe("forbidden"); // override is admin-only
    await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    expect(await code(svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 }))).toBe("conflict");
  });

  it("large refunds need an admin who is not the requester (four-eyes)", async () => {
    const { c, t } = await setup({}, "ZR-DEMO0003");
    const r = await svc.requestRefund(c, admin1, { number: t.number, rentalRef: "ZR-DEMO0003", reason: "defective_equipment", amountCents: 4500 });
    expect(r.requiresAdmin).toBe(true);
    expect(await code(svc.decideRefund(c, agent, r.id, "approve"))).toBe("forbidden");   // not admin
    expect(await code(svc.decideRefund(c, admin1, r.id, "approve"))).toBe("forbidden");  // same person
    expect((await svc.decideRefund(c, admin2, r.id, "approve")).status).toBe("approved");
    expect(await code(svc.decideRefund(c, admin2, r.id, "approve"))).toBe("conflict");   // already decided
  });

  it("denials require a reason", async () => {
    const { c, t } = await setup();
    const r = await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    expect(await code(svc.decideRefund(c, agent, r.id, "deny", "no"))).toBe("invalid");
    expect((await svc.decideRefund(c, agent, r.id, "deny", "Station shows a release at 7:02pm")).status).toBe("denied");
  });

  it("issuing uses the refund id as the provider idempotency key and can never double-issue", async () => {
    const calls: { idempotencyKey: string; amountCents: number; paymentIntentId: string }[] = [];
    const provider: RefundProvider = { refund: async (a) => { calls.push(a); return { ok: true, id: "re_test_1" }; } };
    const { c, t } = await setup({ refunds: provider });
    const r = await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    await svc.decideRefund(c, agent, r.id, "approve");
    expect(await code(svc.issueRefund(c, agent, "00000000-0000-0000-0000-000000000000"))).toBe("not_found");
    const out = await svc.issueRefund(c, agent, r.id);
    expect(out.status).toBe("issued");
    expect(calls).toEqual([{ idempotencyKey: r.id, amountCents: 699, paymentIntentId: "pi_demo_1" }]);
    expect(await code(svc.issueRefund(c, agent, r.id))).toBe("conflict");
    expect(calls).toHaveLength(1);
    const view = await svc.getRequesterThread(c, pat, t.number);
    expect(view.messages.at(-1)!.body).toMatch(/\$6\.99.*issued/);
    expect((await c.repo.listEmails()).some((e) => e.subject.includes("refund has been issued"))).toBe(true);
  });

  it("a failed provider call marks it failed and a retry reuses the same idempotency key", async () => {
    const keys: string[] = [];
    let n = 0;
    const provider: RefundProvider = { refund: async (a) => { keys.push(a.idempotencyKey); return ++n === 1 ? { ok: false, reason: "error", message: "timeout" } : { ok: true, id: "re_ok" }; } };
    const { c, t } = await setup({ refunds: provider });
    const r = await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    await svc.decideRefund(c, agent, r.id, "approve");
    expect((await svc.issueRefund(c, agent, r.id)).status).toBe("failed");
    expect((await svc.issueRefund(c, agent, r.id)).status).toBe("issued");
    expect(new Set(keys).size).toBe(1);
  });

  it("manual recording is admin-only and validates the Stripe refund id", async () => {
    const { c, t } = await setup();
    const r = await svc.requestRefund(c, agent, { number: t.number, rentalRef: "ZR-DEMO0001", reason: "failed_dispense", amountCents: 699 });
    await svc.decideRefund(c, agent, r.id, "approve");
    expect(await code(svc.markRefundIssued(c, agent, r.id, "re_abc123"))).toBe("forbidden");
    expect(await code(svc.markRefundIssued(c, admin1, r.id, "not-an-id"))).toBe("invalid");
    expect((await svc.markRefundIssued(c, admin1, r.id, "re_abc123")).status).toBe("issued");
    expect(await code(svc.markRefundIssued(c, admin1, r.id, "re_abc123"))).toBe("conflict");
  });
});

describe("partner requests", () => {
  const p1: Actor = { kind: "partner", id: "u1", name: "Riverside Tavern", email: "owner@riverside.test", orgId: "org-1" };
  const p2: Actor = { kind: "partner", id: "u2", name: "Other Bar", email: "x@other.test", orgId: "org-2" };
  it("creates partner-queue tickets scoped to the org; other orgs and customers can't see them", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, { requesterType: "partner", name: p1.name, email: p1.email, category: "Station offline or not working", description: "Screen is dark since this morning", orgId: "org-1", venueLabel: "Riverside Tavern" });
    expect(ticket).toMatchObject({ queue: "partner", priority: "high", requesterType: "partner", aiState: "needs_human" });
    expect((await svc.getRequesterThread(c, p1, ticket.number)).number).toBe(ticket.number);
    expect(await code(svc.getRequesterThread(c, p2, ticket.number))).toBe("forbidden");
    expect(await code(svc.getRequesterThread(c, { kind: "customer", email: p1.email }, ticket.number))).toBe("forbidden");
    expect((await c.repo.listTickets({ orgId: "org-1" })).length).toBe(1);
    expect((await c.repo.listTickets({ orgId: "org-2" })).length).toBe(0);
  });
  it("partner hardware safety reports escalate as urgent safety", async () => {
    const c = mk();
    const { ticket } = await svc.createTicket(c, { requesterType: "partner", name: "R", email: "o@r.test", category: "Hardware or safety issue", description: "There is smoke coming from the unit", orgId: "org-1" });
    expect(ticket).toMatchObject({ queue: "safety", priority: "urgent" });
  });
});

describe("access tokens", () => {
  it("round-trips and binds to one ticket", () => {
    const t = signAccess("Z-1001", "Pat@Example.com")!;
    expect(verifyAccess(t, "Z-1001")).toBe("pat@example.com");
    expect(verifyAccess(t, "Z-1002")).toBeNull();
  });
  it("rejects expired, tampered and missing tokens", () => {
    const old = signAccess("Z-1001", "a@b.co", 10, Date.now() - 60_000)!;
    expect(verifyAccess(old, "Z-1001")).toBeNull();
    const t = signAccess("Z-1001", "a@b.co")!;
    const [p, s] = t.split(".");
    expect(verifyAccess(`${p}.${s.slice(0, -2)}xx`, "Z-1001")).toBeNull();
    expect(verifyAccess(`${Buffer.from(JSON.stringify({ n: "Z-1001", e: "evil@x.io", x: 9e9 })).toString("base64url")}.${s}`, "Z-1001")).toBeNull();
    expect(verifyAccess(undefined, "Z-1001")).toBeNull();
  });
});

describe("SLA, outbox, macros, metrics", () => {
  it("computes breach status from due dates", () => {
    const t = { priority: "normal" as const, createdAt: NOW.toISOString(), firstResponseAt: null, resolvedAt: null, state: "open" as const, ...dueDates("normal", NOW) };
    expect(slaStatus(t, new Date(NOW.getTime() + 3600_000)).firstResponse).toBe("ok");
    expect(slaStatus(t, new Date(NOW.getTime() + 25 * 3600_000)).firstResponse).toBe("breached");
    expect(slaStatus({ ...t, firstResponseAt: new Date(NOW.getTime() + 3600_000).toISOString() }, NOW).firstResponse).toBe("met");
  });
  it("outbox stays queued with no mailer, and sends/records failures when one exists", async () => {
    const c = mk();
    await svc.createTicket(c, base);
    expect(await flushOutbox(c.repo, null)).toMatchObject({ sent: 0, queued: 1 });
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await flushOutbox(c.repo, { send })).toMatchObject({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(await c.repo.listEmails("queued")).toHaveLength(0);
    await c.repo.queueEmail({ ticketId: null, to: "a@b.co", subject: "s", body: "b" });
    expect(await flushOutbox(c.repo, { send: async () => { throw new Error("boom"); } })).toMatchObject({ failed: 1 });
    expect((await c.repo.listEmails("failed"))[0].error).toBe("boom");
  });
  it("macros only quote configured prices and never promise refunds", () => {
    const all = MACROS.map((m) => m.body).join(" ");
    expect(all).toContain("$6.99");
    expect(all).toContain("$45");
    expect(replyIsSafe(renderMacro(MACROS.find((m) => m.id === "pricing")!, { name: "Pat", ticket: "Z-1", agent: "Alex" }))).toBe(true);
    expect(all).not.toMatch(/we(?:'ll| will) (?:issue|process) (?:you )?a refund/i);
    expect(renderMacro(MACROS[0], { name: "Pat", ticket: "Z-1001", agent: "Alex" })).toContain("Z-1001");
  });
  it("metrics reflect real ticket data only", async () => {
    const c = mk();
    expect((await computeMetrics(c.repo, NOW)).open).toBe(0);
    expect((await computeMetrics(c.repo, NOW)).aiDeflectionRate).toBeNull();
    const a = (await svc.createTicket(c, base)).ticket;
    await svc.createTicket(c, { ...base, category: "Refund request", description: "refund me" });
    await svc.agentReply(c, agent, a.number, "Done!", "resolved");
    const m = await computeMetrics(c.repo, NOW);
    expect(m).toMatchObject({ open: 1, resolved: 1, byQueue: { billing: 1, customer: 0, partner: 0, safety: 0 } });
    expect(m.avgFirstResponseHours).not.toBeNull();
    expect(m.aiDeflectionRate).toBe(0);
  });
});
