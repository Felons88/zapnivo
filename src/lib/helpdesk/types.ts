export const QUEUES = ["customer", "billing", "partner", "safety"] as const;
export type Queue = (typeof QUEUES)[number];
export const STATES = ["open", "pending_customer", "pending_internal", "resolved", "closed"] as const;
export type TicketState = (typeof STATES)[number];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** none = untouched · ai_active = AI is handling · needs_human = waiting for an agent · human = an agent owns it */
export type AiState = "none" | "ai_active" | "needs_human" | "human";
export type AuthorType = "customer" | "partner" | "agent" | "ai" | "system";
export type RequesterType = "customer" | "partner";

export const PARTNER_CATEGORIES = [
  "Station offline or not working", "Hardware or safety issue", "Placement or relocation", "Statement or payout question",
  "Agreement or contract", "Marketing or signage request", "Guest complaint at my venue", "Other",
] as const;

export type Actor =
  | { kind: "staff"; id: string; name: string; role: "admin" | "staff" }
  | { kind: "customer"; email: string }
  | { kind: "partner"; id: string; name: string; email: string; orgId: string }
  | { kind: "ai" }
  | { kind: "system" };

export type Ticket = {
  id: string;
  number: string;
  requesterType: RequesterType;
  name: string;
  email: string;
  phone: string | null;
  orgId: string | null;
  venueId: string | null;
  venueLabel: string | null;
  category: string;
  subject: string;
  queue: Queue;
  state: TicketState;
  priority: Priority;
  assignedTo: string | null;
  aiState: AiState;
  aiSummary: string | null;
  rentalRef: string | null;
  stationLabel: string | null;
  attachmentPath: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  firstResponseDueAt: string;
  resolutionDueAt: string;
  resolvedAt: string | null;
};

export type Message = {
  id: string;
  ticketId: string;
  authorType: AuthorType;
  authorId: string | null;
  authorName: string;
  /** Internal notes never leave staff. */
  internal: boolean;
  body: string;
  createdAt: string;
};

export type TicketEvent = { id: string; ticketId: string; actor: string; type: string; detail: Record<string, unknown> | null; createdAt: string };

export const REFUND_REASONS = ["failed_dispense", "return_not_recognized", "defective_equipment", "overcharge", "goodwill"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export type RefundStatus = "requested" | "approved" | "denied" | "issued" | "failed";

export type RefundRequest = {
  id: string;
  ticketId: string;
  rentalRef: string;
  paymentIntentId: string | null;
  reason: RefundReason;
  amountCents: number;
  status: RefundStatus;
  requiresAdmin: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  providerRefundId: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  issuedAt: string | null;
};

export type OutboxEmail = { id: string; ticketId: string | null; to: string; subject: string; body: string; status: "queued" | "sent" | "failed"; error: string | null; createdAt: string };

export type TicketFilter = { states?: TicketState[]; queue?: Queue; priority?: Priority; assignedTo?: string | "unassigned"; orgId?: string; aiState?: AiState; q?: string; limit?: number };

export class HelpdeskError extends Error {
  constructor(public code: "forbidden" | "not_found" | "invalid" | "conflict" | "unavailable", message: string) { super(message); }
}
