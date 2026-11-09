import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase";
import type { HelpdeskRepo, NewTicket } from "./repo";
import type { Message, OutboxEmail, RefundRequest, Ticket, TicketEvent, TicketFilter } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const toTicket = (r: Row): Ticket => ({
  id: r.id, number: r.ticket_number, requesterType: r.requester_type, name: r.name, email: r.email, phone: r.phone,
  orgId: r.organization_id, venueId: r.venue_id, venueLabel: r.venue_label, category: r.category, subject: r.subject ?? r.category,
  queue: r.queue, state: r.state, priority: r.priority, assignedTo: r.assigned_to, aiState: r.ai_state, aiSummary: r.ai_summary,
  rentalRef: r.rental_ref, stationLabel: r.station_label, attachmentPath: r.attachment_path, createdAt: r.created_at, updatedAt: r.updated_at,
  firstResponseAt: r.first_response_at, firstResponseDueAt: r.first_response_due_at, resolutionDueAt: r.resolution_due_at, resolvedAt: r.resolved_at,
});
const fromTicket = (t: Partial<Ticket>): Row => {
  const m: Record<string, string> = { requesterType: "requester_type", orgId: "organization_id", venueId: "venue_id", venueLabel: "venue_label", assignedTo: "assigned_to", aiState: "ai_state", aiSummary: "ai_summary", rentalRef: "rental_ref", stationLabel: "station_label", attachmentPath: "attachment_path", firstResponseAt: "first_response_at", firstResponseDueAt: "first_response_due_at", resolutionDueAt: "resolution_due_at", resolvedAt: "resolved_at", updatedAt: "updated_at", createdAt: "created_at", number: "ticket_number" };
  const out: Row = {};
  for (const [k, v] of Object.entries(t)) out[m[k] ?? k] = v;
  if ("description" in out) delete out.description;
  return out;
};
const toMessage = (r: Row): Message => ({ id: r.id, ticketId: r.ticket_id, authorType: r.author_type, authorId: r.author, authorName: r.author_name ?? "", internal: r.internal, body: r.body, createdAt: r.created_at });
const toRefund = (r: Row): RefundRequest => ({
  id: r.id, ticketId: r.ticket_id, rentalRef: r.rental_ref, paymentIntentId: r.payment_intent_id, reason: r.reason, amountCents: r.amount_cents, status: r.status,
  requiresAdmin: r.requires_admin, requestedBy: r.requested_by, decidedBy: r.decided_by, decisionNote: r.decision_note, providerRefundId: r.provider_refund_id,
  error: r.error, createdAt: r.created_at, decidedAt: r.decided_at, issuedAt: r.issued_at,
});
const refundCols: Record<string, string> = { decidedBy: "decided_by", decisionNote: "decision_note", providerRefundId: "provider_refund_id", decidedAt: "decided_at", issuedAt: "issued_at", paymentIntentId: "payment_intent_id", amountCents: "amount_cents" };
const toEmail = (r: Row): OutboxEmail => ({ id: r.id, ticketId: r.ticket_id, to: r.to_email, subject: r.subject, body: r.body, status: r.status, error: r.error, createdAt: r.created_at });

/**
 * Production repository (Supabase Postgres, service role, server-side only).
 * NOTE: written against migrations 0001-0004 but not yet exercised against a live project —
 * run the integration checklist in docs/SUPPORT-OPERATIONS.md before launch.
 */
export class SupabaseRepo implements HelpdeskRepo {
  private db(): SupabaseClient {
    const c = serviceClient();
    if (!c) throw new Error("supabase_unconfigured");
    return c;
  }
  private fail(e: { message: string; code?: string } | null): never | void { if (e) throw new Error(`db_${e.code ?? "error"}: ${e.message}`); }

  async createTicket(t: NewTicket) {
    const { data, error } = await this.db().from("support_tickets").insert({
      name: t.name, email: t.email, phone: t.phone, category: t.category, subject: t.subject, description: t.subject, queue: t.queue, requester_type: t.requesterType,
      organization_id: t.orgId, venue_id: t.venueId, venue_label: t.venueLabel, state: t.state, priority: t.priority, ai_state: t.aiState, ai_summary: t.aiSummary,
      rental_ref: t.rentalRef, station_label: t.stationLabel, attachment_path: t.attachmentPath, consent_at: new Date().toISOString(),
      first_response_due_at: t.firstResponseDueAt, resolution_due_at: t.resolutionDueAt,
    }).select("*").single();
    this.fail(error);
    return toTicket(data!);
  }
  async getTicketByNumber(n: string) { const { data } = await this.db().from("support_tickets").select("*").eq("ticket_number", n).maybeSingle(); return data ? toTicket(data) : null; }
  async getTicket(id: string) { const { data } = await this.db().from("support_tickets").select("*").eq("id", id).maybeSingle(); return data ? toTicket(data) : null; }
  async listTickets(f: TicketFilter = {}) {
    let q = this.db().from("support_tickets").select("*").order("updated_at", { ascending: false }).limit(f.limit ?? 200);
    if (f.states) q = q.in("state", f.states);
    if (f.queue) q = q.eq("queue", f.queue);
    if (f.priority) q = q.eq("priority", f.priority);
    if (f.orgId) q = q.eq("organization_id", f.orgId);
    if (f.aiState) q = q.eq("ai_state", f.aiState);
    if (f.assignedTo) q = f.assignedTo === "unassigned" ? q.is("assigned_to", null) : q.eq("assigned_to", f.assignedTo);
    const { data, error } = await q;
    this.fail(error);
    const needle = f.q?.trim().toLowerCase();
    const rows = (data ?? []).map(toTicket);
    return needle ? rows.filter((t) => `${t.number} ${t.email} ${t.name} ${t.subject} ${t.rentalRef ?? ""}`.toLowerCase().includes(needle)) : rows;
  }
  async updateTicket(id: string, patch: Partial<Ticket>) {
    const { data, error } = await this.db().from("support_tickets").update({ ...fromTicket(patch), updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
    this.fail(error);
    return toTicket(data!);
  }
  async addMessage(m: Omit<Message, "id" | "createdAt">) {
    const authorId = m.authorId && /^[0-9a-f-]{36}$/i.test(m.authorId) ? m.authorId : null;
    const { data, error } = await this.db().from("support_messages").insert({ ticket_id: m.ticketId, author: authorId, author_type: m.authorType, author_name: m.authorName, internal: m.internal, body: m.body }).select("*").single();
    this.fail(error);
    await this.db().from("support_tickets").update({ updated_at: new Date().toISOString() }).eq("id", m.ticketId);
    return toMessage(data!);
  }
  async listMessages(ticketId: string, o: { includeInternal?: boolean } = {}) {
    let q = this.db().from("support_messages").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true });
    if (!o.includeInternal) q = q.eq("internal", false);
    const { data, error } = await q;
    this.fail(error);
    return (data ?? []).map(toMessage);
  }
  async addEvent(e: Omit<TicketEvent, "id" | "createdAt">) { this.fail((await this.db().from("ticket_events").insert({ ticket_id: e.ticketId, actor: e.actor, type: e.type, detail: e.detail }) ).error); }
  async listEvents(ticketId: string) {
    const { data } = await this.db().from("ticket_events").select("*").eq("ticket_id", ticketId).order("created_at", { ascending: true });
    return (data ?? []).map((r: Row): TicketEvent => ({ id: String(r.id), ticketId: r.ticket_id, actor: r.actor, type: r.type, detail: r.detail, createdAt: r.created_at }));
  }

  async createRefund(r: Parameters<HelpdeskRepo["createRefund"]>[0]) {
    const { data, error } = await this.db().from("refund_requests").insert({ ticket_id: r.ticketId, rental_ref: r.rentalRef, payment_intent_id: r.paymentIntentId, reason: r.reason, amount_cents: r.amountCents, requires_admin: r.requiresAdmin, requested_by: r.requestedBy }).select("*").single();
    if (error?.code === "23505") throw new Error("refund_open_exists");
    this.fail(error);
    return toRefund(data!);
  }
  async getRefund(id: string) { const { data } = await this.db().from("refund_requests").select("*").eq("id", id).maybeSingle(); return data ? toRefund(data) : null; }
  async listRefunds(f: { status?: RefundRequest["status"][]; ticketId?: string; rentalRef?: string } = {}) {
    let q = this.db().from("refund_requests").select("*").order("created_at", { ascending: false }).limit(200);
    if (f.status) q = q.in("status", f.status);
    if (f.ticketId) q = q.eq("ticket_id", f.ticketId);
    if (f.rentalRef) q = q.eq("rental_ref", f.rentalRef);
    const { data, error } = await q;
    this.fail(error);
    return (data ?? []).map(toRefund);
  }
  async transitionRefund(id: string, from: RefundRequest["status"][], patch: Partial<RefundRequest>) {
    const row: Row = {};
    for (const [k, v] of Object.entries(patch)) row[refundCols[k] ?? k] = v;
    const { data, error } = await this.db().from("refund_requests").update(row).eq("id", id).in("status", from).select("*").maybeSingle();   // atomic compare-and-set
    this.fail(error);
    return data ? toRefund(data) : null;
  }
  async queueEmail(e: Omit<OutboxEmail, "id" | "createdAt" | "status" | "error">) {
    const { data, error } = await this.db().from("email_outbox").insert({ ticket_id: e.ticketId, to_email: e.to, subject: e.subject, body: e.body }).select("*").single();
    this.fail(error);
    return toEmail(data!);
  }
  async listEmails(status?: OutboxEmail["status"]) {
    let q = this.db().from("email_outbox").select("*").order("created_at", { ascending: true }).limit(200);
    if (status) q = q.eq("status", status);
    const { data } = await q;
    return (data ?? []).map(toEmail);
  }
  async markEmail(id: string, status: "sent" | "failed", error?: string) { await this.db().from("email_outbox").update({ status, error: error ?? null }).eq("id", id); }
}
