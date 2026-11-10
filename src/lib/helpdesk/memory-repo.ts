import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HelpdeskRepo, NewOutboxEmail, NewTicket } from "./repo";
import type { Message, OutboxEmail, RefundRequest, Ticket, TicketEvent, TicketFilter } from "./types";

type State = { seq: number; tickets: Ticket[]; messages: Message[]; events: TicketEvent[]; refunds: RefundRequest[]; emails: OutboxEmail[] };
const now = () => new Date().toISOString();

export class MemoryRepo implements HelpdeskRepo {
  private s: State = { seq: 1000, tickets: [], messages: [], events: [], refunds: [], emails: [] };
  constructor(private file?: string) {
    if (file && existsSync(file)) { try { this.s = JSON.parse(readFileSync(file, "utf8")); } catch { /* start fresh */ } }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.s, null, 2));
  }

  async createTicket(t: NewTicket) {
    const ts = now();
    const row: Ticket = { ...t, id: randomUUID(), number: `Z-${++this.s.seq}`, createdAt: ts, updatedAt: ts, resolvedAt: null, firstResponseAt: null };
    this.s.tickets.push(row); this.save();
    return { ...row };
  }
  async getTicketByNumber(n: string) { const t = this.s.tickets.find((x) => x.number === n); return t ? { ...t } : null; }
  async getTicket(id: string) { const t = this.s.tickets.find((x) => x.id === id); return t ? { ...t } : null; }
  async listTickets(f: TicketFilter = {}) {
    const q = f.q?.trim().toLowerCase();
    return this.s.tickets
      .filter((t) => (!f.states || f.states.includes(t.state)) && (!f.queue || t.queue === f.queue) && (!f.priority || t.priority === f.priority)
        && (!f.orgId || t.orgId === f.orgId) && (!f.aiState || t.aiState === f.aiState)
        && (!f.assignedTo || (f.assignedTo === "unassigned" ? !t.assignedTo : t.assignedTo === f.assignedTo))
        && (!q || `${t.number} ${t.email} ${t.name} ${t.subject} ${t.rentalRef ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, f.limit ?? 200).map((t) => ({ ...t }));
  }
  async updateTicket(id: string, patch: Partial<Ticket>) {
    const t = this.s.tickets.find((x) => x.id === id);
    if (!t) throw new Error("ticket_not_found");
    Object.assign(t, patch, { updatedAt: now() }); this.save();
    return { ...t };
  }
  async addMessage(m: Omit<Message, "id" | "createdAt">) {
    const row: Message = { ...m, id: randomUUID(), createdAt: now() };
    this.s.messages.push(row);
    const t = this.s.tickets.find((x) => x.id === m.ticketId); if (t) t.updatedAt = row.createdAt;
    this.save(); return { ...row };
  }
  async listMessages(ticketId: string, o: { includeInternal?: boolean } = {}) {
    return this.s.messages.filter((m) => m.ticketId === ticketId && (o.includeInternal || !m.internal)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((m) => ({ ...m }));
  }
  async addEvent(e: Omit<TicketEvent, "id" | "createdAt">) { this.s.events.push({ ...e, id: randomUUID(), createdAt: now() }); this.save(); }
  async listEvents(ticketId: string) { return this.s.events.filter((e) => e.ticketId === ticketId).map((e) => ({ ...e })); }

  async createRefund(r: Parameters<HelpdeskRepo["createRefund"]>[0]) {
    if (this.s.refunds.some((x) => x.rentalRef === r.rentalRef && x.status === "requested")) throw new Error("refund_open_exists");
    const row: RefundRequest = { ...r, id: randomUUID(), status: "requested", createdAt: now(), decidedAt: null, issuedAt: null, decidedBy: null, decisionNote: null, providerRefundId: null, error: null };
    this.s.refunds.push(row); this.save(); return { ...row };
  }
  async getRefund(id: string) { const r = this.s.refunds.find((x) => x.id === id); return r ? { ...r } : null; }
  async listRefunds(f: { status?: RefundRequest["status"][]; ticketId?: string; rentalRef?: string } = {}) {
    return this.s.refunds.filter((r) => (!f.status || f.status.includes(r.status)) && (!f.ticketId || r.ticketId === f.ticketId) && (!f.rentalRef || r.rentalRef === f.rentalRef)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({ ...r }));
  }
  async transitionRefund(id: string, from: RefundRequest["status"][], patch: Partial<RefundRequest>) {
    const r = this.s.refunds.find((x) => x.id === id);
    if (!r || !from.includes(r.status)) return null;
    Object.assign(r, patch); this.save(); return { ...r };
  }
  async queueEmail(e: NewOutboxEmail) {
    const row: OutboxEmail = { ...e, id: randomUUID(), status: "queued", error: null, createdAt: now(), sender: e.sender ?? null, replyTo: e.replyTo ?? null, template: e.template ?? null, event: e.event ?? null };
    this.s.emails.push(row); this.save(); return { ...row };
  }
  async listEmails(status?: OutboxEmail["status"]) { return this.s.emails.filter((e) => !status || e.status === status).map((e) => ({ ...e })); }
  async markEmail(id: string, status: "sent" | "failed", error?: string) {
    const e = this.s.emails.find((x) => x.id === id); if (e) { e.status = status; e.error = error ?? null; this.save(); }
  }
}

const g = globalThis as unknown as { __zapnivoDevRepo?: MemoryRepo };
/** Singleton persisted to .data/helpdesk.json so tickets survive dev-server restarts. */
export const devRepo = () => (g.__zapnivoDevRepo ??= new MemoryRepo(".data/helpdesk.json"));
