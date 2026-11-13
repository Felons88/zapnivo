import type { SupabaseClient } from "@supabase/supabase-js";
import { externalAlert } from "../alerts";
import { CONTACTS } from "../contacts";
import { alertStaff } from "../email-triggers";
import { recordLog } from "../observability";
import { subUrl } from "../site";
import { ALWAYS_ESCALATE, classifyByRules, classifyWithModel } from "./classify";
import { authorizeAgent, type AgentGateFn } from "../ai/agent-gate";
import { decideDraftAction, defaultAutonomyLevel, queueReceptionistEmail } from "./draft";
import { scanInjection } from "./injection";
import { auditEvent } from "./service";
import { normalizeSubject, type ReceptionistCategory, type ReceptionistPriority, type ReceptionistStatus } from "./types";

/**
 * Inbound entry point for general-correspondence mail (hello@zapnivo.com).
 * Called from the inbound worker BEFORE helpdesk ticket matching — this path
 * NEVER creates a helpdesk ticket.
 *
 * Pipeline: dedupe → thread match (In-Reply-To, then sender+normalized subject)
 * → store inbound message → rules classify → injection scan → model
 * classify/draft → autonomy-gated draft/send/escalate → audit events.
 */

export type InboundMail = {
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  recipients: string[];
  autoSubmitted?: boolean;
};

export type GeneralOutcome = {
  status: "accepted" | "quarantined" | "ignored" | "duplicate" | "error";
  reason: string | null;
  threadId?: string;
};

export type ReceptionistDb = SupabaseClient;

/** Recipients that route to the receptionist instead of the ticket pipeline. */
export function generalInboxAddresses(): string[] {
  const raw = process.env.GENERAL_INBOX ?? "hello@zapnivo.com";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isGeneralInboxMail(mail: { recipients: string[] }): boolean {
  const inbox = generalInboxAddresses();
  return mail.recipients.some((r) => inbox.includes(r.toLowerCase()));
}

/* ── Monitored contact addresses ────────────────────────────────────────────
 * The verified public registry (contacts.ts) marks which addresses a human
 * team actually reads. Mail addressed to one of these that carries no valid
 * ticket credential is routed here by the inbound processor instead of being
 * silently dropped — unknown addresses keep the old ignore behavior.
 */
export function monitoredContactAddresses(): string[] {
  return Object.values(CONTACTS).filter((c) => c.monitored).map((c) => c.email.toLowerCase());
}

const ADDR_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** First recipient matching a monitored contact address (plus-tags ignored), or null. */
export function monitoredRecipient(mail: { recipients: string[] }): string | null {
  const known = new Set(monitoredContactAddresses());
  for (const raw of mail.recipients) {
    const addr = raw.toLowerCase().match(ADDR_RE)?.[0];
    if (!addr) continue;
    const [local, domain] = addr.split("@");
    const base = `${local.split("+")[0]}@${domain}`;
    if (known.has(base)) return addr;
  }
  return null;
}

const stripQuoted = (text: string) => {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^>/.test(l.trimStart())) break;
    if (/^On .+wrote:\s*$/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim();
};

const PRIORITY_RANK: Record<ReceptionistPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const higherPriority = (a: ReceptionistPriority, b: ReceptionistPriority) =>
  (PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b);

type ThreadMatch = { id: string; subject: string; status: string } | null;

/** Finds an existing thread: In-Reply-To provider id first, then sender+subject. */
async function findThread(db: ReceptionistDb, mail: InboundMail): Promise<ThreadMatch> {
  if (mail.inReplyTo) {
    const { data } = await db.from("receptionist_messages")
      .select("thread_id").eq("message_id", mail.inReplyTo).limit(1).maybeSingle();
    const tid = (data as { thread_id?: string } | null)?.thread_id;
    if (tid) {
      const { data: t } = await db.from("receptionist_threads")
        .select("id,subject,status").eq("id", tid).maybeSingle();
      if (t) return t as ThreadMatch;
    }
  }
  const { data: candidates } = await db.from("receptionist_threads")
    .select("id,subject,status")
    .eq("sender_email", mail.from.toLowerCase())
    .order("last_message_at", { ascending: false }).limit(25);
  const key = normalizeSubject(mail.subject);
  for (const t of (candidates ?? []) as { id: string; subject: string; status: string }[]) {
    if (normalizeSubject(t.subject) === key) return t;
  }
  return null;
}

async function insertMessage(db: ReceptionistDb, row: Record<string, unknown>) {
  const { error } = await db.from("receptionist_messages").insert(row);
  return error;
}

/**
 * Processes one normalized inbound message. `db` is the service client —
 * required (receptionist state lives only in Postgres).
 */
export async function ingestGeneralMail(db: ReceptionistDb, mail: InboundMail, opts: { agentGate?: AgentGateFn } = {}): Promise<GeneralOutcome> {
  const started = Date.now();
  const body = stripQuoted(mail.text).slice(0, 20_000);

  // Provider message-id dedupe (partial unique index backs this).
  if (mail.messageId) {
    const { data: dupe } = await db.from("receptionist_messages")
      .select("id").eq("message_id", mail.messageId).limit(1);
    if (dupe?.length) return { status: "duplicate", reason: "duplicate_message_id" };
  }

  // Thread match → append, or create + classify.
  const existing = await findThread(db, mail);
  const now = new Date().toISOString();

  if (existing) {
    const msgErr = await insertMessage(db, {
      thread_id: existing.id, direction: "inbound", message_id: mail.messageId,
      from_addr: mail.from, to_addr: mail.recipients[0] ?? null,
      subject: mail.subject.slice(0, 500), body_text: body,
      sender_kind: "customer", created_at: now,
    });
    if (msgErr?.code === "23505") return { status: "duplicate", reason: "duplicate_message_id" };
    if (msgErr) return { status: "error", reason: "message_insert_failed" };

    const reopen = ["resolved", "archived"].includes(existing.status) ? "waiting" : null;
    await db.from("receptionist_threads").update({
      updated_at: now, last_message_at: now, ...(reopen ? { status: reopen } : {}),
    }).eq("id", existing.id);
    await auditEvent(db, existing.id, "system", "message.received", {
      direction: "inbound", chars: body.length, reopened: Boolean(reopen),
    });
    recordLog("info", "receptionist.message_appended", {
      service: "receptionist", attrs: { thread: existing.id, ms: Date.now() - started },
    });
    return { status: "accepted", reason: null, threadId: existing.id };
  }

  // ── New thread ──────────────────────────────────────────────────────────
  const autonomy = defaultAutonomyLevel();
  const { data: tRow, error: tErr } = await db.from("receptionist_threads").insert({
    sender_email: mail.from.toLowerCase(),
    subject: mail.subject.slice(0, 500) || "(no subject)",
    category: "unknown", status: "ai_reviewing", priority: "normal",
    autonomy_level: autonomy, last_message_at: now,
  }).select("id").single();
  if (tErr || !tRow) return { status: "error", reason: "thread_insert_failed" };
  const threadId = (tRow as { id: string }).id;

  const msgErr = await insertMessage(db, {
    thread_id: threadId, direction: "inbound", message_id: mail.messageId,
    from_addr: mail.from, to_addr: mail.recipients[0] ?? null,
    subject: mail.subject.slice(0, 500), body_text: body, sender_kind: "customer",
    created_at: now,
  });
  if (msgErr) {
    await db.from("receptionist_threads").delete().eq("id", threadId);
    return msgErr.code === "23505"
      ? { status: "duplicate", reason: "duplicate_message_id" }
      : { status: "error", reason: "message_insert_failed" };
  }

  await auditEvent(db, threadId, "system", "thread.created", {
    autonomy_level: autonomy, has_reply_token: Boolean(mail.inReplyTo),
  });

  // Auto-submitted / obvious spam short-circuit: quarantine, no AI spend.
  const rules = classifyByRules(mail.subject, body);
  const injection = scanInjection(mail.subject, body);
  const isAuto = Boolean(mail.autoSubmitted) || rules?.category === "spam";

  let category: ReceptionistCategory = rules?.category ?? "unknown";
  let priority: ReceptionistPriority = rules?.priority ?? "normal";
  let confidence: number | null = null;
  let escalate = false;
  let escalationReason: string | null = null;
  let draft: string | null = null;
  let aiOk = false;
  let via: "rules" | "model" | "none" = rules ? "rules" : "none";

  if (isAuto) {
    category = "spam";
    escalate = true;
    escalationReason = mail.autoSubmitted ? "auto_submitted" : "rules_spam";
  } else {
    // FAIL-CLOSED: the gate does a fresh ai_agents read on THIS db per call —
    // disabled/unverifiable → no model call, thread escalates to a human.
    const agentGate = opts.agentGate ?? ((id: string) => authorizeAgent(id, db, "receptionist"));
    const model = await classifyWithModel({ subject: mail.subject, from: mail.from, bodyText: body }, undefined, agentGate);
    if (model.ok) {
      aiOk = true;
      via = "model";
      category = model.result.category;
      priority = higherPriority(priority, model.result.priority);
      confidence = model.result.confidence;
      draft = model.result.draft_reply;
      escalate = model.result.escalate;
      escalationReason = model.result.escalation_reason;
      // Rules outrank the model on hard categories the model may soften.
      if (rules && ["refund", "security", "legal"].includes(rules.category)) {
        category = rules.category;
        priority = higherPriority(priority, rules.priority);
      }
    } else if (rules) {
      via = "rules";
      escalate = true;
      escalationReason = model.ok ? null : `ai_fallback:${("reason" in model ? model.reason : "unknown")}`;
    } else {
      escalate = true;
      escalationReason = `ai_fallback:${model.ok ? "unknown" : model.reason}`;
    }
  }

  // Injection flags always force human review, regardless of confidence.
  if (injection.flagged) {
    escalate = true;
    escalationReason = escalationReason
      ? `${escalationReason}+injection:${injection.flags.join(",")}`
      : `injection:${injection.flags.join(",")}`;
  }
  if (ALWAYS_ESCALATE.has(category)) {
    escalate = true;
    escalationReason = escalationReason ?? `category:${category}`;
  }
  if (priority === "urgent" && !escalationReason) {
    escalate = true;
    escalationReason = "priority:urgent";
  }

  // Sanitized audit: flag NAMES only, never the triggering text.
  await auditEvent(db, threadId, "ai", "ai.classified", {
    via, category, confidence, priority, escalate,
    injection_flags: injection.flags, draft: Boolean(draft), ms: Date.now() - started,
  });
  if (category === "venue_inquiry") await auditEvent(db, threadId, "ai", "lead.venue_inquiry", {});
  if (category === "advertising") await auditEvent(db, threadId, "ai", "lead.advertising", {});

  const decision = decideDraftAction({
    autonomyLevel: autonomy, category, confidence, hasDraft: Boolean(draft),
    escalate, escalationReason, injectionFlagged: injection.flagged, aiAvailable: aiOk,
  });

  let status: ReceptionistStatus = decision.status;
  if (isAuto) status = "quarantined";

  // Persist draft or auto-send.
  if (decision.action === "store_draft" && draft) {
    await db.from("receptionist_messages").insert({
      thread_id: threadId, direction: "draft", from_addr: "hello@zapnivo.com",
      to_addr: mail.from, subject: `Re: ${mail.subject.slice(0, 400)}`,
      body_text: draft, sender_kind: "ai",
    });
    await auditEvent(db, threadId, "ai", "draft.created", { chars: draft.length });
  } else if (decision.action === "auto_send" && draft) {
    const subject = mail.subject ? `Re: ${mail.subject.replace(/^re:\s*/i, "").slice(0, 400)}` : "Re: your message to Zapnivo";
    const res = await queueReceptionistEmail(mail.from, subject, draft);
    if (res.ok && res.sent) {
      await db.from("receptionist_messages").insert({
        thread_id: threadId, direction: "outbound", from_addr: "hello@zapnivo.com",
        to_addr: mail.from, subject, body_text: draft, sender_kind: "ai",
      });
      await auditEvent(db, threadId, "ai", "email.auto_sent", { category, confidence });
      status = "waiting";
    } else if (res.ok) {
      // Queued in the outbox but unconfirmed (no provider / send failed). Keep
      // the draft for staff review and stay OUT of "waiting" — the customer
      // has not been answered yet.
      status = "awaiting_approval";
      await db.from("receptionist_messages").insert({
        thread_id: threadId, direction: "draft", from_addr: "hello@zapnivo.com",
        to_addr: mail.from, subject: `Re: ${mail.subject.slice(0, 400)}`,
        body_text: draft, sender_kind: "ai",
      });
      await auditEvent(db, threadId, "ai", "email.queued", { reason: res.reason ?? "unconfirmed", category });
    } else {
      status = "awaiting_approval";
      await auditEvent(db, threadId, "ai", "email.auto_send_failed", { error: res.error ?? "unknown" });
    }
  }
  if (decision.action === "escalate" || isAuto) {
    await auditEvent(db, threadId, "system", isAuto ? "thread.quarantined" : "thread.escalated", {
      reason: escalationReason, category,
    });
    await alertStaffEscalation(db, threadId, mail, {
      kind: isAuto ? "quarantined" : "escalated", category, priority, reason: escalationReason,
    });
  }

  await db.from("receptionist_threads").update({
    category, status, priority,
    ai_confidence: confidence,
    escalation_reason: escalationReason ? escalationReason.slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  }).eq("id", threadId);

  recordLog("info", "receptionist.thread_created", {
    service: "receptionist",
    attrs: { thread: threadId, category, status, via, escalate, injection: injection.flags.length, ms: Date.now() - started },
  });

  return {
    status: isAuto ? "quarantined" : "accepted",
    reason: isAuto ? escalationReason : null,
    threadId,
  };
}

/* ── Staff alerting on escalation / quarantine ──────────────────────────────
 * Only NEW threads reach classification, but a spam burst still creates many
 * threads — the per-(kind,category) cooldown keeps a flood from becoming a
 * flood of staff emails. externalAlert adds the webhook path (own cooldown,
 * no-op when ALERT_WEBHOOK_URL is unset).
 */
const staffAlertCooldown = new Map<string, number>();
const staffAlertCooldownMs = () => {
  const n = Number(process.env.RECEPTIONIST_ALERT_COOLDOWN_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
};
/** Test hook: clears the in-process alert cooldown. */
export const resetStaffAlertCooldowns = () => staffAlertCooldown.clear();

async function alertStaffEscalation(
  db: ReceptionistDb,
  threadId: string,
  mail: InboundMail,
  info: { kind: "escalated" | "quarantined"; category: ReceptionistCategory; priority: ReceptionistPriority; reason: string | null },
): Promise<void> {
  const key = `${info.kind}:${info.category}`;
  const now = Date.now();
  if (now - (staffAlertCooldown.get(key) ?? 0) < staffAlertCooldownMs()) return;
  staffAlertCooldown.set(key, now);

  const inboxUrl = subUrl("internal", `/receptionist?thread=${threadId}`);
  externalAlert(
    `receptionist:${key}`,
    `Receptionist thread ${info.kind}`,
    `category=${info.category} priority=${info.priority} reason=${info.reason ?? "—"} thread=${threadId} inbox=${inboxUrl}`,
    info.kind === "quarantined" ? "warning" : "critical",
  );
  await alertStaff({
    subject: `Receptionist ${info.kind}: ${info.category} — ${mail.from}`.slice(0, 200),
    body: [
      `A new general-inbox thread was ${info.kind}.`,
      ``,
      `Thread: ${threadId}`,
      `Inbox: ${inboxUrl}`,
      `From: ${mail.from}`,
      `Subject: ${mail.subject}`,
      `Category: ${info.category} · Priority: ${info.priority}`,
      `Reason: ${info.reason ?? "—"}`,
      ``,
      `— Zapnivo receptionist`,
    ].join("\n"),
    sender: "admin",
    event: "receptionist.escalation",
  }, db);
}
