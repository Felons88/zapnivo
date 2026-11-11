import { createHash } from "node:crypto";
import { requesterMessage, type Ctx } from "../helpdesk/service";
import { HelpdeskError } from "../helpdesk/types";
import { parsePlusReply, verifyReplyToken, type PlusReply } from "../email/inbound";
import { serviceClient } from "../supabase";
import { ingestGeneralMail, isGeneralInboxMail } from "../receptionist/ingest";

/**
 * Stage-B inbound email processor — runs inside the durable worker
 * (/api/cron/inbound), never inside the webhook request. Takes a normalized
 * Parsed payload (produced by the webhook's Stage-A parser), verifies the
 * reply token / sender, matches the ticket, and records the outcome in
 * inbound_emails. Idempotent: Message-ID unique index + content-hash dedupe
 * make retries and duplicate deliveries safe.
 */

export type Parsed = {
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  recipients: string[];
  dmarc: string | null;
  spf: string | null;
  dkim: string | null;
  /** Auto-Submitted/Precedence/bulk or obvious autoresponder — never answer these (loop prevention). */
  autoSubmitted?: boolean;
};

export type Outcome = { status: string; reason: string | null; ticket?: string; authMethod?: string };

type Db = NonNullable<ReturnType<typeof serviceClient>>;

const TICKET_RE = /\bZ-\d+\b/i;
const DEDUPE_WINDOW_MS = 15 * 60_000;

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

async function logInbound(db: Db | null, row: Record<string, unknown>) {
  if (!db) return null;
  const { data, error } = await db.from("inbound_emails").insert(row).select("id").single();
  if (error) return error.code === "23505" ? ("duplicate" as const) : null;
  return (data as { id: string } | null)?.id ?? null;
}

const updateLog = (db: Db | null, id: string | null, patch: Record<string, unknown>) =>
  id && db ? db.from("inbound_emails").update(patch).eq("id", id) : Promise.resolve({ error: null });

export async function processInboundMail(c: Ctx | null, db: Db | null, mail: Parsed): Promise<Outcome> {
  const started = Date.now();
  const body = stripQuoted(mail.text).slice(0, 2000);
  const dedupeHash = createHash("sha256").update(`${mail.from}|${mail.subject}|${body}`).digest("hex").slice(0, 32);
  const base = {
    message_id: mail.messageId, dedupe_hash: dedupeHash, from_email: mail.from,
    to_address: mail.recipients[0] ?? null, subject: mail.subject,
    dmarc_result: mail.dmarc, spf_result: mail.spf, dkim_result: mail.dkim,
    body_preview: body.slice(0, 200) || null,
  };

  const logId = await logInbound(db, { ...base, status: "ignored", reason: "processing" });
  if (logId === "duplicate") return { status: "duplicate", reason: "duplicate_message_id" };
  if (db && !mail.messageId) {
    const { data: dupe } = await db.from("inbound_emails")
      .select("id").eq("dedupe_hash", dedupeHash)
      .gte("created_at", new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()).limit(1);
    if (dupe?.length) {
      await updateLog(db, logId, { status: "duplicate", reason: "content_hash", processed_ms: Date.now() - started });
      return { status: "duplicate", reason: "content_hash" };
    }
  }

  const finish = async (status: string, reason: string | null, extra: Record<string, unknown> = {}): Promise<Outcome> => {
    await updateLog(db, logId, { status, reason, processed_ms: Date.now() - started, ...extra });
    return { status, reason, ticket: extra.ticket_number as string | undefined, authMethod: extra.auth_method as string | undefined };
  };

  if (mail.dmarc === "fail") return finish("quarantined", "dmarc_fail");
  if (mail.autoSubmitted && !isGeneralInboxMail(mail)) return finish("ignored", "auto_submitted");
  if (!body) return finish("ignored", "empty_body");

  // General-correspondence desk: mail addressed to hello@zapnivo.com (or
  // GENERAL_INBOX) goes to the AI receptionist — NEVER a helpdesk ticket.
  // Runs before ticket-token matching so support@ behavior is unchanged.
  if (isGeneralInboxMail(mail)) {
    if (!db) return finish("error", "receptionist_db_unavailable");
    try {
      const r = await ingestGeneralMail(db, mail);
      return finish(r.status === "duplicate" ? "duplicate" : r.status === "error" ? "error" : r.status === "quarantined" ? "quarantined" : "accepted", r.reason);
    } catch (e) {
      return finish("error", "receptionist_error");
    }
  }
  if (!c) return finish("error", "helpdesk_unavailable");

  // Reply-token path: scan every provider-supplied recipient; the HMAC token
  // is self-authenticating regardless of which header carried it.
  const plusCandidates: { ticket: NonNullable<Awaited<ReturnType<typeof c.repo.getTicketByNumber>>> }[] = [];
  for (const r of mail.recipients) {
    const plus: PlusReply | null = parsePlusReply(r);
    if (!plus) continue;
    const ticket = await c.repo.getTicketByNumber(plus.number);
    if (ticket && verifyReplyToken(ticket.number, ticket.email, ticket.orgId, plus.token)) {
      plusCandidates.push({ ticket });
    }
  }
  if (plusCandidates.length) {
    const ticket = plusCandidates[0].ticket;
    if (mail.from !== ticket.email.toLowerCase()) {
      return finish("quarantined", "sender_mismatch", { ticket_number: ticket.number, auth_method: "reply_token" });
    }
    try {
      await requesterMessage(c, { kind: "customer", email: mail.from }, ticket.number, body);
      return finish("accepted", null, { ticket_number: ticket.number, auth_method: "reply_token" });
    } catch (e) {
      if (e instanceof HelpdeskError) return finish("ignored", e.code, { ticket_number: ticket.number, auth_method: "reply_token" });
      return finish("error", "processing_error", { ticket_number: ticket.number, auth_method: "reply_token" });
    }
  }
  if (mail.recipients.some((r) => parsePlusReply(r))) {
    return finish("quarantined", "bad_reply_token");
  }

  // Legacy fallback: Z-<n> reference + sender match.
  const num = (mail.subject.match(TICKET_RE) ?? mail.text.slice(0, 500).match(TICKET_RE))?.[0].toUpperCase();
  if (!num) return finish("ignored", "no_ticket_reference");
  const ticket = await c.repo.getTicketByNumber(num);
  if (!ticket) return finish("ignored", "unknown_ticket", { ticket_number: num });

  let actor: Parameters<typeof requesterMessage>[1] = { kind: "customer", email: mail.from };
  if (ticket.requesterType === "partner" && db) {
    const { data: p } = await db.from("profiles").select("id,role,organization_id,full_name").ilike("email", mail.from).maybeSingle();
    const prof = p as { id: string; role: string; organization_id: string | null; full_name: string | null } | null;
    if (prof?.role === "partner" && prof.organization_id && prof.organization_id === ticket.orgId) {
      actor = { kind: "partner", id: prof.id, name: prof.full_name ?? mail.from, email: mail.from, orgId: prof.organization_id };
    }
  }

  try {
    await requesterMessage(c, actor, num, body);
    return finish("accepted", null, { ticket_number: num, auth_method: "legacy_from_match" });
  } catch (e) {
    if (e instanceof HelpdeskError) return finish("ignored", e.code, { ticket_number: num, auth_method: "legacy_from_match" });
    return finish("error", "processing_error", { ticket_number: num, auth_method: "legacy_from_match" });
  }
}
