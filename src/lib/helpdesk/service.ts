import { buildSystemPrompt } from "../ai/knowledge";
import { assistantConfigured, openrouterChat, type ChatFn } from "../ai/openrouter";
import { fmt } from "../pricing";
import { getRefundProvider, type RefundProvider } from "../payments/source";
import { describeRental, type RentalResult } from "../rental-lookup";
import { SITE, subUrl } from "../site";
import { signAccess } from "./access";
import { renderEmail } from "../email-templates";
import { flushOutbox, getMailer, type Mailer } from "./mailer";
import { requiresAdmin, snapshot, suggestRefund } from "./refund-policy";
import { getRepo, type HelpdeskRepo } from "./repo";
import { getRentalDirectory, type RentalDirectory } from "./rentals";
import { dueDates } from "./sla";
import { classify, followUp, HANDOFF_MESSAGE, HUMAN_REQUESTED_MESSAGE, replyIsSafe, triage } from "./triage";
import { HelpdeskError, type Actor, type Message, type Priority, type RefundReason, type RefundRequest, type RequesterType, type Ticket, type TicketState } from "./types";

export type Ctx = { repo: HelpdeskRepo; chat: ChatFn | null; mailer: Mailer | null; rentals: RentalDirectory; refunds: RefundProvider; now: () => Date; siteUrl: string };

export async function defaultCtx(): Promise<Ctx | null> {
  const repo = await getRepo();
  if (!repo) return null;
  return { repo, chat: assistantConfigured() ? openrouterChat : null, mailer: getMailer(), rentals: getRentalDirectory(), refunds: getRefundProvider(), now: () => new Date(), siteUrl: SITE.url };
}

type Staff = Extract<Actor, { kind: "staff" }>;
const staffOnly = (a: Actor): Staff => { if (a.kind !== "staff") throw new HelpdeskError("forbidden", "Staff access required."); return a; };
const adminOnly = (a: Actor): Staff => { const s = staffOnly(a); if (s.role !== "admin") throw new HelpdeskError("forbidden", "Admin access required."); return s; };
const label = (a: Actor) => (a.kind === "staff" || a.kind === "partner" ? `${a.kind}:${a.name}` : a.kind === "customer" ? `customer:${a.email}` : a.kind);

const audit = (c: Ctx, ticketId: string, actor: Actor, type: string, detail?: Record<string, unknown>) => c.repo.addEvent({ ticketId, actor: label(actor), type, detail: detail ?? null });

const ticketLink = (c: Ctx, t: Ticket) => (t.requesterType === "partner" ? subUrl("partners", `/support/${t.number}`, c.siteUrl) : subUrl("support", `/ticket/${t.number}${(() => { const tok = signAccess(t.number, t.email); return tok ? `?t=${tok}` : ""; })()}`, c.siteUrl));

/** Writes to the outbox, then best-effort sends. If no mailer is configured the email simply stays queued. */
async function notify(c: Ctx, t: Ticket, subject: string, body: string, kind: "created" | "updated" = "updated", htmlOverride?: string) {
  const link = ticketLink(c, t);
  const vars = {
    ticket_id: t.number, ticket_subject: t.subject, ticket_status: t.state.replace(/_/g, " "),
    ticket_url: link, year: String(new Date().getFullYear()),
    [`${kind}_at`]: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
  };
  const html = htmlOverride ?? (kind === "created" ? renderEmail("support_created", vars) : renderEmail("support_updated", vars));
  await c.repo.queueEmail({ ticketId: t.id, to: t.email, subject: `[${t.number}] ${subject}`, body: `${body}\n\n— View or reply: ${link}\n\nZapnivo Support`, html });
  try { await flushOutbox(c.repo, c.mailer); } catch { /* recorded per-email */ }
}

async function must(c: Ctx, number: string): Promise<Ticket> {
  const t = await c.repo.getTicketByNumber(number);
  if (!t) throw new HelpdeskError("not_found", "Ticket not found.");
  return t;
}

/* ───────────────────────── Creating tickets (customer and partner) ───────────────────────── */

export type NewTicketInput = {
  requesterType: RequesterType; name: string; email: string; phone?: string | null; category: string; description: string; subject?: string;
  rentalRef?: string | null; stationLabel?: string | null; attachmentPath?: string | null; orgId?: string | null; venueId?: string | null; venueLabel?: string | null;
};

export async function createTicket(c: Ctx, input: NewTicketInput): Promise<{ ticket: Ticket; token: string | null }> {
  const cls = classify({ requesterType: input.requesterType, category: input.category, text: `${input.category} ${input.description}` });
  const now = c.now();
  let ticket = await c.repo.createTicket({
    requesterType: input.requesterType, name: input.name, email: input.email.toLowerCase(), phone: input.phone ?? null, orgId: input.orgId ?? null, venueId: input.venueId ?? null,
    venueLabel: input.venueLabel ?? null, category: input.category, subject: input.subject ?? `${input.category}: ${input.description.replace(/\s+/g, " ").slice(0, 70)}`,
    queue: cls.queue, state: "open", priority: cls.priority, assignedTo: null, aiState: "none", aiSummary: null, rentalRef: input.rentalRef ?? null,
    stationLabel: input.stationLabel ?? null, attachmentPath: input.attachmentPath ?? null, ...dueDates(cls.priority, now),
  });
  await c.repo.addMessage({ ticketId: ticket.id, authorType: input.requesterType, authorId: null, authorName: input.name, internal: false, body: input.description });
  await audit(c, ticket.id, { kind: "system" }, "created", { queue: cls.queue, priority: cls.priority, safety: cls.safety });

  const decision = await triage(ticket, input.description, cls, { chat: c.chat, link: ticketLink(c, ticket) }).catch(() => null);
  const d = decision ?? { reply: "", kind: "system" as const, aiState: "needs_human" as const, summary: null };
  if (d.reply) await c.repo.addMessage({ ticketId: ticket.id, authorType: d.kind === "ai" ? "ai" : "system", authorId: null, authorName: d.kind === "ai" ? "Zapnivo Assistant" : "Zapnivo", internal: false, body: d.reply });
  if (d.summary) await c.repo.addMessage({ ticketId: ticket.id, authorType: "ai", authorId: null, authorName: "AI triage", internal: true, body: `Summary for agent: ${d.summary}` });
  ticket = await c.repo.updateTicket(ticket.id, { aiState: d.aiState, aiSummary: d.summary, state: d.aiState === "ai_active" ? "pending_customer" : "open" });
  await audit(c, ticket.id, { kind: "ai" }, "triage", { kind: d.kind, aiState: d.aiState, auto_reply: !!d.reply });
  if (d.reply) await notify(c, ticket, "We received your request", d.reply, "created");
  return { ticket, token: ticket.requesterType === "customer" ? signAccess(ticket.number, ticket.email) : null };
}

/* ───────────────────────── Customer & partner replies ───────────────────────── */

function assertOwner(t: Ticket, actor: Actor) {
  if (actor.kind === "customer" && t.requesterType === "customer" && actor.email.toLowerCase() === t.email.toLowerCase()) return;
  if (actor.kind === "partner" && t.requesterType === "partner" && t.orgId && actor.orgId === t.orgId) return;
  throw new HelpdeskError("forbidden", "You don't have access to this ticket.");
}

export async function requesterMessage(c: Ctx, actor: Actor, number: string, body: string): Promise<Ticket> {
  const t = await must(c, number);
  assertOwner(t, actor);
  const text = body.trim();
  if (!text || text.length > 2000) throw new HelpdeskError("invalid", "Message must be 1–2000 characters.");
  await c.repo.addMessage({ ticketId: t.id, authorType: t.requesterType, authorId: null, authorName: t.name, internal: false, body: text });
  await audit(c, t.id, actor, "requester_message");

  const reopen = { resolvedAt: null as string | null };
  if (t.aiState === "ai_active" && t.requesterType === "customer") {
    const thread = await c.repo.listMessages(t.id);
    const aiTurns = thread.filter((m) => m.authorType === "ai").length;
    const r = aiTurns >= 3 ? { reply: "", kind: "system" as const, aiState: "needs_human" as const } : await followUp(t, thread, { chat: c.chat });
    const reply = r.reply || HANDOFF_MESSAGE;
    await c.repo.addMessage({ ticketId: t.id, authorType: r.kind === "ai" ? "ai" : "system", authorId: null, authorName: r.kind === "ai" ? "Zapnivo Assistant" : "Zapnivo", internal: false, body: reply });
    await audit(c, t.id, { kind: "ai" }, "ai_follow_up", { aiState: r.aiState });
    const u = await c.repo.updateTicket(t.id, { ...reopen, aiState: r.aiState, state: r.aiState === "ai_active" ? "pending_customer" : "open" });
    await notify(c, u, "Update on your request", reply);
    return u;
  }
  return c.repo.updateTicket(t.id, { ...reopen, state: "open" });
}

export async function requestHuman(c: Ctx, actor: Actor, number: string): Promise<Ticket> {
  const t = await must(c, number);
  assertOwner(t, actor);
  if (t.aiState === "human" || t.aiState === "needs_human") return t;
  await c.repo.addMessage({ ticketId: t.id, authorType: "system", authorId: null, authorName: "Zapnivo", internal: false, body: HUMAN_REQUESTED_MESSAGE });
  await audit(c, t.id, actor, "escalated_to_human");
  return c.repo.updateTicket(t.id, { aiState: "needs_human", state: "open", resolvedAt: null });
}

/** Customer closes the loop themselves ("that solved it"). */
export async function requesterResolve(c: Ctx, actor: Actor, number: string): Promise<Ticket> {
  const t = await must(c, number);
  assertOwner(t, actor);
  await audit(c, t.id, actor, "requester_marked_resolved");
  return c.repo.updateTicket(t.id, { state: "resolved", resolvedAt: c.now().toISOString() });
}

/* ───────────────────────── Agent operations ───────────────────────── */

export async function agentReply(c: Ctx, actor: Actor, number: string, body: string, state: Extract<TicketState, "pending_customer" | "pending_internal" | "resolved"> = "pending_customer"): Promise<Ticket> {
  const s = staffOnly(actor);
  const t = await must(c, number);
  const text = body.trim();
  if (!text || text.length > 4000) throw new HelpdeskError("invalid", "Reply must be 1–4000 characters.");
  await c.repo.addMessage({ ticketId: t.id, authorType: "agent", authorId: s.id, authorName: s.name, internal: false, body: text });
  const now = c.now().toISOString();
  const u = await c.repo.updateTicket(t.id, { aiState: "human", state, assignedTo: t.assignedTo ?? s.id, firstResponseAt: t.firstResponseAt ?? now, resolvedAt: state === "resolved" ? now : null });
  await audit(c, t.id, actor, "agent_reply", { state });
  await notify(c, u, state === "resolved" ? "Your request has been resolved" : "A reply to your request", text);
  return u;
}

export async function internalNote(c: Ctx, actor: Actor, number: string, body: string): Promise<void> {
  const s = staffOnly(actor);
  const t = await must(c, number);
  if (!body.trim() || body.length > 4000) throw new HelpdeskError("invalid", "Note must be 1–4000 characters.");
  await c.repo.addMessage({ ticketId: t.id, authorType: "agent", authorId: s.id, authorName: s.name, internal: true, body: body.trim() });
  await audit(c, t.id, actor, "internal_note");
}

export async function assign(c: Ctx, actor: Actor, number: string, assigneeId: string | null): Promise<Ticket> {
  staffOnly(actor);
  const t = await must(c, number);
  await audit(c, t.id, actor, "assigned", { from: t.assignedTo, to: assigneeId });
  return c.repo.updateTicket(t.id, { assignedTo: assigneeId });
}

export async function setState(c: Ctx, actor: Actor, number: string, state: TicketState): Promise<Ticket> {
  staffOnly(actor);
  const t = await must(c, number);
  await audit(c, t.id, actor, "state_changed", { from: t.state, to: state });
  return c.repo.updateTicket(t.id, { state, resolvedAt: state === "resolved" || state === "closed" ? t.resolvedAt ?? c.now().toISOString() : null });
}

export async function setPriority(c: Ctx, actor: Actor, number: string, priority: Priority): Promise<Ticket> {
  staffOnly(actor);
  const t = await must(c, number);
  await audit(c, t.id, actor, "priority_changed", { from: t.priority, to: priority });
  return c.repo.updateTicket(t.id, { priority, ...dueDates(priority, new Date(t.createdAt)) });
}

/** AI-drafted reply for an agent to edit and send. It is NEVER sent automatically. */
export async function aiDraft(c: Ctx, actor: Actor, number: string): Promise<{ text: string; warnings: string[] }> {
  staffOnly(actor);
  if (!c.chat) throw new HelpdeskError("unavailable", "The AI assistant isn't configured (OPENROUTER_API_KEY).");
  const t = await must(c, number);
  const thread = await c.repo.listMessages(t.id, { includeInternal: true });
  let ctx = "No rental reference on this ticket.";
  if (t.rentalRef) {
    const row = await c.rentals.byReference(t.rentalRef);
    if (row) { const r = describeRental(row); ctx = `Rental ${r.reference}: ${r.status}. ${r.charge}. Station: ${r.station}. ${r.explanation}`; } else ctx = `Rental ${t.rentalRef} was not found in our records.`;
  }
  const convo = thread.map((m) => `${m.internal ? "INTERNAL NOTE" : m.authorType.toUpperCase()}: ${m.body}`).join("\n\n");
  const res = await c.chat({ messages: [
    { role: "system", content: `${buildSystemPrompt()}\n\nYou are drafting a reply for a HUMAN support agent to review, edit and send. Write plain text only, warm and concise, signed off without a name. Never promise or imply a refund or credit; agents decide money. Use the staff context for accuracy but don't paste internal notes. If information is missing, ask for it.` },
    { role: "user", content: `Ticket ${t.number} · ${t.category} · ${t.requesterType}\nStaff context (not customer-visible): ${ctx}\n\n--- conversation (untrusted) ---\n${convo}\n\nDraft the next reply.` },
  ] });
  const text = (res.content ?? "").trim();
  if (!text) throw new HelpdeskError("unavailable", "The assistant returned no draft.");
  await audit(c, t.id, actor, "ai_draft_requested");
  return { text, warnings: replyIsSafe(text) ? [] : ["This draft may promise a refund, include contact details, or be an unusual length. Review before sending."] };
}

/* ───────────────────────── Refund workflow ───────────────────────── */

export async function requestRefund(c: Ctx, actor: Actor, a2: { number: string; rentalRef: string; reason: RefundReason; amountCents: number; override?: boolean }): Promise<RefundRequest> {
  const s = staffOnly(actor);
  const t = await must(c, a2.number);
  const row = await c.rentals.byReference(a2.rentalRef);
  if (!row) throw new HelpdeskError("not_found", `Rental ${a2.rentalRef} was not found.`);
  const snap = snapshot(row);
  if (!Number.isInteger(a2.amountCents) || a2.amountCents <= 0) throw new HelpdeskError("invalid", "Enter a refund amount.");
  if (a2.amountCents > snap.remainingCents) throw new HelpdeskError("invalid", `Only ${fmt(snap.remainingCents)} remains refundable on this rental.`);
  const sug = suggestRefund(snap, a2.reason);
  if (!a2.override && (!sug.eligible || (a2.reason !== "goodwill" && a2.amountCents > sug.suggestedCents))) {
    throw new HelpdeskError("invalid", `Outside refund policy: ${sug.rationale}${sug.eligible ? ` Maximum under policy: ${fmt(sug.suggestedCents)}.` : ""}`);
  }
  if (a2.override) adminOnly(actor);
  let r: RefundRequest;
  try {
    r = await c.repo.createRefund({ ticketId: t.id, rentalRef: snap.reference, paymentIntentId: snap.paymentIntentId, reason: a2.reason, amountCents: a2.amountCents, requiresAdmin: requiresAdmin(a2.amountCents, a2.reason), requestedBy: s.id });
  } catch (e) {
    if (e instanceof Error && e.message === "refund_open_exists") throw new HelpdeskError("conflict", "There is already an open refund request for this rental.");
    throw e;
  }
  await audit(c, t.id, actor, "refund_requested", { refund: r.id, amountCents: r.amountCents, reason: r.reason, requiresAdmin: r.requiresAdmin, override: !!a2.override });
  await c.repo.updateTicket(t.id, { state: "pending_internal" });
  return r;
}

export async function decideRefund(c: Ctx, actor: Actor, refundId: string, decision: "approve" | "deny", note?: string): Promise<RefundRequest> {
  const s = staffOnly(actor);
  const r = await c.repo.getRefund(refundId);
  if (!r) throw new HelpdeskError("not_found", "Refund request not found.");
  if (r.status !== "requested") throw new HelpdeskError("conflict", `This refund is already ${r.status}.`);
  if (r.requiresAdmin && (s.role !== "admin" || s.id === r.requestedBy)) throw new HelpdeskError("forbidden", "This amount needs approval from an admin other than the requester.");
  if (decision === "deny" && (note ?? "").trim().length < 5) throw new HelpdeskError("invalid", "Add a reason when denying a refund.");
  const u = await c.repo.transitionRefund(refundId, ["requested"], { status: decision === "approve" ? "approved" : "denied", decidedBy: s.id, decisionNote: note?.trim() || null, decidedAt: c.now().toISOString() });
  if (!u) throw new HelpdeskError("conflict", "Someone else already decided this refund.");
  await audit(c, r.ticketId, actor, decision === "approve" ? "refund_approved" : "refund_denied", { refund: r.id, amountCents: r.amountCents, note: note ?? null });
  return u;
}

export type IssueResult = { refund: RefundRequest; status: "issued" | "deferred" | "failed"; message: string };

/** Issues an approved refund through the provider. Idempotent: the refund id is the provider idempotency key. */
export async function issueRefund(c: Ctx, actor: Actor, refundId: string): Promise<IssueResult> {
  staffOnly(actor);
  const r = await c.repo.getRefund(refundId);
  if (!r) throw new HelpdeskError("not_found", "Refund request not found.");
  if (r.status !== "approved" && r.status !== "failed") throw new HelpdeskError("conflict", r.status === "issued" ? "This refund was already issued." : `Only approved refunds can be issued (this one is ${r.status}).`);
  if (!r.paymentIntentId) throw new HelpdeskError("invalid", "No payment is linked to this rental, so it can't be refunded automatically. Refund it manually and record it.");

  const row = await c.rentals.byReference(r.rentalRef);
  if (!row || r.amountCents > snapshot(row).remainingCents) throw new HelpdeskError("invalid", "The refundable balance has changed. Review this request again.");

  const out = await c.refunds.refund({ paymentIntentId: r.paymentIntentId, amountCents: r.amountCents, idempotencyKey: r.id });
  if (!out.ok && out.reason === "not_configured") { await audit(c, r.ticketId, actor, "refund_issue_deferred", { refund: r.id }); return { refund: r, status: "deferred", message: out.message }; }
  if (!out.ok) {
    const f = await c.repo.transitionRefund(r.id, ["approved", "failed"], { status: "failed", error: out.message.slice(0, 300) });
    await audit(c, r.ticketId, actor, "refund_failed", { refund: r.id, reason: out.reason });
    return { refund: f ?? r, status: "failed", message: out.message };
  }
  return finishIssue(c, actor, r, out.id);
}

/** Admin records a refund that was issued manually in the Stripe dashboard. Unique provider id blocks double-recording. */
export async function markRefundIssued(c: Ctx, actor: Actor, refundId: string, providerRefundId: string): Promise<IssueResult> {
  adminOnly(actor);
  const r = await c.repo.getRefund(refundId);
  if (!r) throw new HelpdeskError("not_found", "Refund request not found.");
  if (r.status !== "approved" && r.status !== "failed") throw new HelpdeskError("conflict", `Only approved refunds can be recorded as issued (this one is ${r.status}).`);
  if (!/^re_[A-Za-z0-9_]+$/.test(providerRefundId) && !/^demo_[A-Za-z0-9_]+$/.test(providerRefundId)) throw new HelpdeskError("invalid", "Enter the Stripe refund id (re_…).");
  return finishIssue(c, actor, r, providerRefundId, true);
}

async function finishIssue(c: Ctx, actor: Actor, r: RefundRequest, providerId: string, manual = false): Promise<IssueResult> {
  const done = await c.repo.transitionRefund(r.id, ["approved", "failed"], { status: "issued", providerRefundId: providerId, issuedAt: c.now().toISOString(), error: null });
  if (!done) throw new HelpdeskError("conflict", "This refund was already issued.");
  await audit(c, r.ticketId, actor, manual ? "refund_recorded_manual" : "refund_issued", { refund: r.id, amountCents: r.amountCents, provider: providerId });
  const t = await c.repo.getTicket(r.ticketId);
  if (t) {
    const msg = `A refund of ${fmt(r.amountCents)} for rental ${r.rentalRef} has been issued to your original payment method. Banks post refunds on their own schedule, so it may take some time to appear.`;
    await c.repo.addMessage({ ticketId: t.id, authorType: "system", authorId: null, authorName: "Zapnivo", internal: false, body: msg });
    await notify(c, t, "Your refund has been issued", msg, "updated", renderEmail("refund_processed", {
      refund_amount: fmt(r.amountCents), refund_id: r.id.slice(0, 8).toUpperCase(), refund_url: ticketLink(c, t),
      rental_id: r.rentalRef ?? "—", processed_at: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      year: String(new Date().getFullYear()),
    }));
  }
  return { refund: done, status: "issued", message: "Refund issued." };
}

/* ───────────────────────── Views (what each audience may see) ───────────────────────── */

export type PublicMessage = { authorType: Message["authorType"]; authorName: string; body: string; createdAt: string };
export type CustomerThread = { number: string; category: string; subject: string; state: TicketState; withPerson: boolean; createdAt: string; messages: PublicMessage[] };

export async function getRequesterThread(c: Ctx, actor: Actor, number: string): Promise<CustomerThread> {
  const t = await must(c, number);
  assertOwner(t, actor);
  const msgs = await c.repo.listMessages(t.id);
  return { number: t.number, category: t.category, subject: t.subject, state: t.state, withPerson: t.aiState === "human" || t.aiState === "needs_human", createdAt: t.createdAt, messages: msgs.map((m) => ({ authorType: m.authorType, authorName: m.authorName, body: m.body, createdAt: m.createdAt })) };
}

export async function getStaffThread(c: Ctx, actor: Actor, number: string) {
  staffOnly(actor);
  const t = await must(c, number);
  const [messages, events, refunds] = await Promise.all([c.repo.listMessages(t.id, { includeInternal: true }), c.repo.listEvents(t.id), c.repo.listRefunds({ ticketId: t.id })]);
  let rental: RentalResult | null = null;
  let remainingCents: number | null = null;
  if (t.rentalRef) {
    const row = await c.rentals.byReference(t.rentalRef);
    if (row) { rental = describeRental(row); remainingCents = snapshot(row).remainingCents; }
  }
  return { ticket: t, messages, events, refunds, rental, remainingCents };
}
