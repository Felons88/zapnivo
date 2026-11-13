import type { SupabaseClient } from "@supabase/supabase-js";
import { queueReceptionistEmail } from "./draft";
import {
  FOLDER_STATUSES, STAFF_TRANSITIONS,
  type AuditRow, type Folder, type MessageRow, type ReceptionistCategory,
  type ReceptionistStatus, type ThreadRow,
} from "./types";

/**
 * DB access + staff actions for the receptionist. Every function takes the
 * service client explicitly; routes/pages do their own auth. All mutations
 * write a receptionist_audit_events row.
 */

export type ReceptionistDb = SupabaseClient;

const THREAD_COLS = "id,sender_email,subject,category,status,priority,autonomy_level,assigned_to,ai_confidence,escalation_reason,created_at,updated_at,last_message_at";
const MESSAGE_COLS = "id,thread_id,direction,message_id,from_addr,to_addr,subject,body_text,body_html,sender_kind,created_at";
const AUDIT_COLS = "id,thread_id,actor,action,detail,created_at";

const asThread = (r: unknown) => r as ThreadRow;
const asMessage = (r: unknown) => r as MessageRow;
const asAudit = (r: unknown) => r as AuditRow;

export async function auditEvent(
  db: ReceptionistDb,
  threadId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.from("receptionist_audit_events").insert({
    thread_id: threadId, actor: actor.slice(0, 120), action: action.slice(0, 80),
    detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
  });
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type ThreadFilter = {
  folder?: Folder;
  status?: ReceptionistStatus;
  category?: ReceptionistCategory;
  q?: string;
  limit?: number;
};

export type ThreadListItem = ThreadRow & { preview: string | null; owner_label: string | null };

export async function listThreads(db: ReceptionistDb, f: ThreadFilter = {}): Promise<ThreadListItem[]> {
  let q = db.from("receptionist_threads").select(THREAD_COLS)
    .order("last_message_at", { ascending: false })
    .limit(Math.min(300, Math.max(1, f.limit ?? 100)));

  const statuses = f.status ? [f.status] : f.folder ? FOLDER_STATUSES[f.folder] : null;
  if (statuses?.length) q = q.in("status", [...statuses]);
  if (f.category) q = q.eq("category", f.category);
  if (f.q) {
    const term = f.q.replace(/[%_,()"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (term) q = q.or(`subject.ilike.*${term}*,sender_email.ilike.*${term}*`);
  }
  const { data, error } = await q;
  if (error || !data?.length) return [];
  const threads = (data as unknown as ThreadRow[]);

  // Latest inbound message per thread → preview line.
  const ids = threads.map((t) => t.id);
  const { data: msgs } = await db.from("receptionist_messages")
    .select("thread_id,body_text,created_at")
    .in("thread_id", ids).eq("direction", "inbound")
    .order("created_at", { ascending: false }).limit(500);
  const preview = new Map<string, string>();
  for (const m of (msgs ?? []) as { thread_id: string; body_text: string }[]) {
    if (!preview.has(m.thread_id)) preview.set(m.thread_id, (m.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 160));
  }

  // Owner labels for assigned threads.
  const assignees = [...new Set(threads.map((t) => t.assigned_to).filter((x): x is string => Boolean(x)))];
  const ownerLabels = new Map<string, string>();
  if (assignees.length) {
    const { data: profs } = await db.from("profiles").select("id,email,full_name").in("id", assignees);
    for (const p of (profs ?? []) as { id: string; email: string | null; full_name: string | null }[]) {
      ownerLabels.set(p.id, p.full_name || p.email || p.id);
    }
  }

  return threads.map((t) => ({
    ...t,
    preview: preview.get(t.id) ?? null,
    owner_label: t.assigned_to ? ownerLabels.get(t.assigned_to) ?? null : null,
  }));
}

export async function getThread(db: ReceptionistDb, id: string): Promise<ThreadRow | null> {
  const { data, error } = await db.from("receptionist_threads").select(THREAD_COLS).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return asThread(data);
}

export async function listMessages(db: ReceptionistDb, threadId: string): Promise<MessageRow[]> {
  const { data, error } = await db.from("receptionist_messages").select(MESSAGE_COLS)
    .eq("thread_id", threadId).order("created_at", { ascending: true }).limit(500);
  if (error) return [];
  return ((data ?? []) as unknown as MessageRow[]);
}

export async function listAudit(db: ReceptionistDb, threadId: string): Promise<AuditRow[]> {
  const { data, error } = await db.from("receptionist_audit_events").select(AUDIT_COLS)
    .eq("thread_id", threadId).order("created_at", { ascending: false }).limit(200);
  if (error) return [];
  return ((data ?? []) as unknown as AuditRow[]);
}

export async function getThreadDetail(db: ReceptionistDb, id: string) {
  const thread = await getThread(db, id);
  if (!thread) return null;
  const [messages, audit] = await Promise.all([listMessages(db, id), listAudit(db, id)]);
  const drafts = messages.filter((m) => m.direction === "draft");
  const latestDraft = drafts[drafts.length - 1] ?? null;
  const sentAfterDraft = latestDraft
    ? messages.some((m) => m.direction === "outbound" && m.created_at > latestDraft.created_at)
    : true;
  return { thread, messages, audit, draft: latestDraft && !sentAfterDraft ? latestDraft : null };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export type ActionResult =
  | { ok: true; delivery?: "sent" | "queued" }
  | { ok: false; error: string; status?: number };

const touch = () => ({ updated_at: new Date().toISOString() });

/** Staff reply: queues via the outbox, records the outbound message, reopens waiting. */
export async function replyToThread(
  db: ReceptionistDb,
  threadId: string,
  staff: { id: string; email: string },
  body: string,
): Promise<ActionResult> {
  const thread = await getThread(db, threadId);
  if (!thread) return { ok: false, error: "not_found", status: 404 };
  const text = body.trim();
  if (!text || text.length > 20_000) return { ok: false, error: "invalid_body" };
  const subject = thread.subject ? `Re: ${thread.subject.replace(/^re:\s*/i, "")}` : "Re: your message to Zapnivo";

  const sent = await queueReceptionistEmail(thread.sender_email, subject, text);
  if (!sent.ok) return { ok: false, error: sent.error ?? "send_failed", status: 503 };
  if (!sent.sent) {
    // Queued in the outbox but NOT confirmed delivered (no provider configured,
    // or the send failed and will be retried). The thread must not claim the
    // customer was answered — no outbound message, no "waiting" status.
    await auditEvent(db, threadId, staff.email || staff.id, "reply.queued", {
      reason: sent.reason ?? "unconfirmed", chars: text.length,
    });
    return { ok: true, delivery: "queued" };
  }

  await db.from("receptionist_messages").insert({
    thread_id: threadId, direction: "outbound", from_addr: "hello@zapnivo.com",
    to_addr: thread.sender_email, subject, body_text: text, sender_kind: "staff",
  });
  await db.from("receptionist_threads").update({
    ...touch(), status: "waiting", last_message_at: new Date().toISOString(),
  }).eq("id", threadId);
  await auditEvent(db, threadId, staff.email || staff.id, "reply.sent", { chars: text.length });
  return { ok: true, delivery: "sent" };
}

/** Internal note — never leaves the building. */
export async function addInternalNote(
  db: ReceptionistDb, threadId: string, staff: { id: string; email: string }, body: string,
): Promise<ActionResult> {
  const thread = await getThread(db, threadId);
  if (!thread) return { ok: false, error: "not_found", status: 404 };
  const text = body.trim();
  if (!text || text.length > 10_000) return { ok: false, error: "invalid_body" };
  await db.from("receptionist_messages").insert({
    thread_id: threadId, direction: "internal", from_addr: staff.email || staff.id,
    to_addr: null, subject: null, body_text: text, sender_kind: "staff",
  });
  await auditEvent(db, threadId, staff.email || staff.id, "note.added", { chars: text.length });
  return { ok: true };
}

export async function assignThread(
  db: ReceptionistDb, threadId: string, staffId: string, actor: string,
): Promise<ActionResult> {
  const thread = await getThread(db, threadId);
  if (!thread) return { ok: false, error: "not_found", status: 404 };
  const { data: prof } = await db.from("profiles").select("id,role").eq("id", staffId).maybeSingle();
  const p = prof as { id: string; role: string } | null;
  if (!p || (p.role !== "admin" && p.role !== "staff")) return { ok: false, error: "invalid_assignee", status: 422 };
  const patch: Record<string, unknown> = { ...touch(), assigned_to: staffId };
  if (["new", "ai_reviewing", "awaiting_approval", "draft_ready"].includes(thread.status)) patch.status = "assigned";
  await db.from("receptionist_threads").update(patch).eq("id", threadId);
  await auditEvent(db, threadId, actor, "thread.assigned", { assignee: staffId });
  return { ok: true };
}

export async function transitionThread(
  db: ReceptionistDb, threadId: string, to: ReceptionistStatus, actor: string,
): Promise<ActionResult> {
  const thread = await getThread(db, threadId);
  if (!thread) return { ok: false, error: "not_found", status: 404 };
  if (!STAFF_TRANSITIONS[thread.status].includes(to)) {
    return { ok: false, error: `cannot_move_${thread.status}_to_${to}`, status: 422 };
  }
  await db.from("receptionist_threads").update({ ...touch(), status: to }).eq("id", threadId);
  await auditEvent(db, threadId, actor, "thread.transition", { from: thread.status, to });
  return { ok: true };
}

/** Approves (optionally edited) AI draft and sends it. Only from draft-bearing states. */
export async function approveDraft(
  db: ReceptionistDb, threadId: string, staff: { id: string; email: string }, editedBody?: string,
): Promise<ActionResult> {
  const detail = await getThreadDetail(db, threadId);
  if (!detail) return { ok: false, error: "not_found", status: 404 };
  const { thread, draft } = detail;
  if (!draft) return { ok: false, error: "no_pending_draft", status: 422 };
  if (!["draft_ready", "awaiting_approval", "assigned", "new", "ai_reviewing"].includes(thread.status)) {
    return { ok: false, error: "thread_not_draftable", status: 422 };
  }
  const body = (editedBody ?? draft.body_text).trim();
  if (!body || body.length > 20_000) return { ok: false, error: "invalid_body" };
  const subject = thread.subject ? `Re: ${thread.subject.replace(/^re:\s*/i, "")}` : "Re: your message to Zapnivo";

  const sent = await queueReceptionistEmail(thread.sender_email, subject, body);
  if (!sent.ok) return { ok: false, error: sent.error ?? "send_failed", status: 503 };
  if (!sent.sent) {
    // Same honesty rule as replyToThread: queued ≠ delivered. Keep the draft
    // pending and the thread out of "waiting" until a provider confirms.
    await auditEvent(db, threadId, staff.email || staff.id, "draft.queued", {
      draft_id: draft.id, reason: sent.reason ?? "unconfirmed",
    });
    return { ok: true, delivery: "queued" };
  }

  await db.from("receptionist_messages").insert({
    thread_id: threadId, direction: "outbound", from_addr: "hello@zapnivo.com",
    to_addr: thread.sender_email, subject, body_text: body, sender_kind: "staff",
  });
  await db.from("receptionist_threads").update({
    ...touch(), status: "waiting", last_message_at: new Date().toISOString(),
  }).eq("id", threadId);
  await auditEvent(db, threadId, staff.email || staff.id, "draft.approved", {
    draft_id: draft.id, edited: editedBody !== undefined && editedBody.trim() !== draft.body_text.trim(),
  });
  return { ok: true, delivery: "sent" };
}

export type { ReceptionistCategory };
