/**
 * AI receptionist — shared types. Server code lives in sibling modules; this
 * file is safe to import from client components (page UI).
 *
 * The receptionist is the general-correspondence desk for hello@zapnivo.com.
 * It is intentionally separate from helpdesk tickets: no ticket is ever
 * created here, and the AI can never issue refunds or take financial actions.
 */

export const RECEPTIONIST_CATEGORIES = [
  "general", "venue_inquiry", "advertising", "enterprise", "event_charging",
  "press", "vendor", "customer_support", "billing", "refund", "security",
  "legal", "employment", "spam", "unknown",
] as const;
export type ReceptionistCategory = (typeof RECEPTIONIST_CATEGORIES)[number];

export const RECEPTIONIST_STATUSES = [
  "new", "ai_reviewing", "draft_ready", "awaiting_approval",
  "assigned", "waiting", "resolved", "quarantined", "archived",
] as const;
export type ReceptionistStatus = (typeof RECEPTIONIST_STATUSES)[number];

export const RECEPTIONIST_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ReceptionistPriority = (typeof RECEPTIONIST_PRIORITIES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound", "draft", "internal"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const SENDER_KINDS = ["customer", "ai", "staff", "system"] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

/** Admin inbox folders → the thread statuses they display. */
export const FOLDERS = [
  "new", "ai_reviewing", "draft_ready", "awaiting_approval",
  "assigned", "waiting", "resolved", "spam", "archived",
] as const;
export type Folder = (typeof FOLDERS)[number];

export const FOLDER_STATUSES: Record<Folder, readonly ReceptionistStatus[]> = {
  new: ["new"],
  ai_reviewing: ["ai_reviewing"],
  draft_ready: ["draft_ready"],
  awaiting_approval: ["awaiting_approval"],
  assigned: ["assigned"],
  waiting: ["waiting"],
  resolved: ["resolved"],
  spam: ["quarantined"],
  archived: ["archived"],
};

export const FOLDER_LABELS: Record<Folder, string> = {
  new: "New",
  ai_reviewing: "AI reviewing",
  draft_ready: "Draft ready",
  awaiting_approval: "Awaiting approval",
  assigned: "Assigned",
  waiting: "Waiting",
  resolved: "Resolved",
  spam: "Spam / quarantined",
  archived: "Archived",
};

/** Statuses a staff member may set via the transition endpoint. */
export const STAFF_TRANSITIONS: Record<ReceptionistStatus, readonly ReceptionistStatus[]> = {
  new: ["ai_reviewing", "awaiting_approval", "assigned", "resolved", "archived", "quarantined"],
  ai_reviewing: ["draft_ready", "awaiting_approval", "assigned", "resolved", "archived", "quarantined"],
  draft_ready: ["awaiting_approval", "assigned", "waiting", "resolved", "archived", "quarantined"],
  awaiting_approval: ["draft_ready", "assigned", "waiting", "resolved", "archived", "quarantined"],
  assigned: ["waiting", "resolved", "archived", "awaiting_approval", "quarantined"],
  waiting: ["assigned", "resolved", "archived", "awaiting_approval"],
  resolved: ["waiting", "archived", "awaiting_approval"],
  quarantined: ["archived", "awaiting_approval"],
  archived: ["awaiting_approval"],
};

export type ThreadRow = {
  id: string;
  sender_email: string;
  subject: string;
  category: ReceptionistCategory;
  status: ReceptionistStatus;
  priority: ReceptionistPriority;
  autonomy_level: number;
  assigned_to: string | null;
  ai_confidence: number | null;
  escalation_reason: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  direction: MessageDirection;
  message_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  sender_kind: SenderKind;
  created_at: string;
};

export type AuditRow = {
  id: string;
  thread_id: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
};

/** Normalizes a subject for app-level thread matching: strips reply/forward
 * prefixes and collapses whitespace/case. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|aw|sv|vs)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/** Extracts bare addresses from a "Name <a@b>" or comma-separated recipient string. */
export function extractAddresses(raw: string): string[] {
  const out = new Set<string>();
  for (const m of raw.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0].toLowerCase());
  return [...out];
}
