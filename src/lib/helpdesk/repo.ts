import { backendConfigured } from "../supabase";
import type { Message, OutboxEmail, RefundRequest, Ticket, TicketEvent, TicketFilter } from "./types";

export type NewTicket = Omit<Ticket, "id" | "number" | "createdAt" | "updatedAt" | "resolvedAt" | "firstResponseAt">;
/** queueEmail input: routing fields (sender/replyTo/template/event) are optional for backward compatibility. */
export type NewOutboxEmail = Omit<OutboxEmail, "id" | "createdAt" | "status" | "error" | "sender" | "replyTo" | "template" | "event">
  & Partial<Pick<OutboxEmail, "sender" | "replyTo" | "template" | "event">>;

/** Storage port. SupabaseRepo is production; MemoryRepo powers tests and the explicit dev-only local store. */
export interface HelpdeskRepo {
  createTicket(t: NewTicket): Promise<Ticket>;
  getTicketByNumber(number: string): Promise<Ticket | null>;
  getTicket(id: string): Promise<Ticket | null>;
  listTickets(f?: TicketFilter): Promise<Ticket[]>;
  updateTicket(id: string, patch: Partial<Omit<Ticket, "id" | "number" | "createdAt">>): Promise<Ticket>;
  addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message>;
  listMessages(ticketId: string, opts?: { includeInternal?: boolean }): Promise<Message[]>;
  addEvent(e: Omit<TicketEvent, "id" | "createdAt">): Promise<void>;
  listEvents(ticketId: string): Promise<TicketEvent[]>;
  createRefund(r: Omit<RefundRequest, "id" | "createdAt" | "decidedAt" | "issuedAt" | "decidedBy" | "decisionNote" | "providerRefundId" | "error" | "status">): Promise<RefundRequest>;
  getRefund(id: string): Promise<RefundRequest | null>;
  listRefunds(f?: { status?: RefundRequest["status"][]; ticketId?: string; rentalRef?: string }): Promise<RefundRequest[]>;
  /** Compare-and-set style update: returns null if the refund is no longer in one of `from` states. */
  transitionRefund(id: string, from: RefundRequest["status"][], patch: Partial<RefundRequest>): Promise<RefundRequest | null>;
  queueEmail(e: NewOutboxEmail): Promise<OutboxEmail>;
  listEmails(status?: OutboxEmail["status"]): Promise<OutboxEmail[]>;
  markEmail(id: string, status: "sent" | "failed", error?: string): Promise<void>;
}

/** Explicit, development-only local store (JSON file). Never active in production. */
export const devStoreEnabled = () => process.env.NODE_ENV === "development" && process.env.HELPDESK_DEV_STORE === "1";

let cached: HelpdeskRepo | null | undefined;

export async function getRepo(): Promise<HelpdeskRepo | null> {
  if (cached !== undefined) return cached;
  if (backendConfigured()) cached = new (await import("./supabase-repo")).SupabaseRepo();
  else if (devStoreEnabled()) cached = (await import("./memory-repo")).devRepo();
  else cached = null;
  return cached;
}

/** Test hook. */
export const setRepoForTests = (r: HelpdeskRepo | null | undefined) => { cached = r; };
