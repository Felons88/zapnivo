import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { defaultCtx, requesterMessage } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";
import { parsePlusReply, verifyReplyToken, type PlusReply } from "@/lib/email/inbound";
import { serviceClient } from "@/lib/supabase";

/**
 * Inbound email webhook — turns replies to support@/partners@zapnivo.com into
 * ticket messages. Provider: Brevo Inbound Parsing (docs/DEPLOYMENT.md).
 *
 * Payload: https://developers.brevo.com/docs/inbound-parse-webhooks — a top-level
 * `items` array; each item has From{Address,Name}, To[] mailboxes, Recipients[]
 * envelope strings, MessageId, InReplyTo, RawTextBody/RawHtmlBody,
 * ExtractedMarkdownMessage, SpamScore, and Headers (object; repeated headers
 * are arrays). Flat field payloads (simple JSON/form) are also accepted.
 *
 * Auth layers (defense in depth):
 *  1. Shared secret — EMAIL_INBOUND_SECRET (comma-separated for rotation).
 *     Accepted via `?key=`, `Authorization: Bearer`, or `X-Zapnivo-Inbound-Key`.
 *     Brevo inbound webhooks cannot be signed, so secret + TLS is the provider
 *     authentication. Never logged.
 *  2. Reply token — outbound ticket emails carry
 *     `support+<TICKET>-<hmac>@zapnivo.com` Reply-To. Google Workspace
 *     forwarding rewrites the envelope recipient but preserves the original
 *     To header, which survives into Brevo's To[]/Headers — the HMAC token is
 *     self-authenticating, so extracting it from any provider-supplied
 *     recipient field is safe; forged tokens still fail verification.
 *  3. Sender match — From must equal the ticket requester's email.
 *  4. Legacy fallback — subject `Z-<n>` + From match for pre-token mail.
 *  5. DMARC — provider Authentication-Results with dmarc=fail quarantines.
 *
 * Every item is logged to inbound_emails (dedupe by MessageId, then by
 * content hash) — accepted, quarantined, rejected, ignored, duplicate, error.
 */

const MAX_BODY_BYTES = 2_000_000;
const MAX_ITEMS = 50;
const DEDUPE_WINDOW_MS = 15 * 60_000;

const secrets = () => (process.env.EMAIL_INBOUND_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const authorized = (req: Request) => {
  const list = secrets();
  if (!list.length) return false;
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = req.headers.get("authorization") ?? "";
  const keyParam = new URL(req.url).searchParams.get("key") ?? "";
  const keyHeader = req.headers.get("x-zapnivo-inbound-key") ?? "";
  return list.some((s) => eq(bearer, `Bearer ${s}`) || eq(keyParam, s) || eq(keyHeader, s));
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const TICKET_RE = /\bZ-\d+\b/i;

const emailOf = (raw: string) => raw.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;

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

const htmlToText = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").trim();

// ── Parsed message shape ────────────────────────────────────────────────────

type Parsed = {
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  /** All recipient candidates, most-trusted first (envelope → To header → raw headers). */
  recipients: string[];
  dmarc: string | null;
  spf: string | null;
  dkim: string | null;
};

type Fields = Record<string, string>;

const pick = (f: Fields, ...names: string[]) => { for (const n of names) if (f[n]) return f[n]; return ""; };

const headerValues = (h: Record<string, unknown>, name: string): string[] => {
  const v = h[name] ?? h[name.toLowerCase()];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
};

/** spf/dkim/dmarc out of Authentication-Results header text or JSON. */
const authResults = (raw: string): { dmarc: string | null; spf: string | null; dkim: string | null } => {
  if (!raw) return { dmarc: null, spf: null, dkim: null };
  let hay = raw;
  try { const j = JSON.parse(raw); if (j && typeof j === "object") hay = JSON.stringify(j); } catch { /* header text */ }
  const grab = (k: string) => hay.match(new RegExp(`${k}=(\\w+)`, "i"))?.[1]?.toLowerCase() ?? null;
  return { dmarc: grab("dmarc"), spf: grab("spf"), dkim: grab("dkim") };
};

const mailboxAddr = (m: unknown): string | null => {
  if (typeof m === "string") return emailOf(m);
  if (m && typeof m === "object") return emailOf(String((m as { Address?: unknown }).Address ?? ""));
  return null;
};

// ── Brevo item → Parsed ─────────────────────────────────────────────────────

const brevoItem = (it: Record<string, unknown>): Parsed | null => {
  const from = mailboxAddr(it.From ?? it.from);
  if (!from) return null;

  const recipients: string[] = [];
  const push = (addr: string | null) => { if (addr && !recipients.includes(addr)) recipients.push(addr); };

  // Envelope recipients first (provider-trusted), then To mailboxes, then raw
  // header values that may carry the original token-bearing recipient.
  for (const r of Array.isArray(it.Recipients) ? it.Recipients : []) push(typeof r === "string" ? emailOf(r) : mailboxAddr(r));
  for (const t of Array.isArray(it.To) ? it.To : []) push(mailboxAddr(t));
  for (const c of Array.isArray(it.Cc) ? it.Cc : []) push(mailboxAddr(c));

  const headers = (it.Headers && typeof it.Headers === "object" ? it.Headers : {}) as Record<string, unknown>;
  for (const name of ["To", "Delivered-To", "X-Original-To", "Envelope-To", "X-Forwarded-To", "Apparently-To"]) {
    for (const v of headerValues(headers, name)) {
      for (const m of v.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) push(m[0].toLowerCase());
    }
  }

  const text = String(it.ExtractedMarkdownMessage ?? "").trim()
    || String(it.RawTextBody ?? "").trim()
    || (it.RawHtmlBody ? htmlToText(String(it.RawHtmlBody)) : "");

  const arParts = [
    ...headerValues(headers, "Authentication-Results"),
    ...headerValues(headers, "ARC-Authentication-Results"),
  ].join(" ");
  const ar = authResults(arParts || String(it["Authentication-Results"] ?? ""));

  return {
    from,
    subject: String(it.Subject ?? "").slice(0, 500),
    text: text.slice(0, 50_000),
    messageId: String(it.MessageId ?? "").trim() || null,
    inReplyTo: String(it.InReplyTo ?? "").trim() || null,
    recipients,
    dmarc: ar.dmarc, spf: ar.spf, dkim: ar.dkim,
  };
};

// ── Flat/simple payload → Parsed ────────────────────────────────────────────

const flatFields = async (req: Request): Promise<Fields | null> => {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j !== "object") return null;
    const f: Fields = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === "string") f[k.toLowerCase()] = v;
      else if (v && typeof v === "object") f[k.toLowerCase()] = JSON.stringify(v);
    }
    return f;
  }
  const form = await req.formData().catch(() => null);
  if (!form) return null;
  const f: Fields = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") f[k.toLowerCase()] = v;
  return f;
};

const flatParsed = (f: Fields): Parsed | null => {
  const fromRaw = pick(f, "from", "sender");
  const m = fromRaw.match(/<([^>]+)>/);
  const from = emailOf(m?.[1] ?? fromRaw);
  if (!from) return null;
  const headersRaw = pick(f, "headers", "header");
  let hdrTo = "";
  if (headersRaw) {
    try {
      const h = JSON.parse(headersRaw) as Record<string, unknown>;
      hdrTo = headerValues(h, "To").join(" ") + " " + headerValues(h, "Delivered-To").join(" ");
    } catch { hdrTo = headersRaw; }
  }
  const recipients = [
    pick(f, "to", "delivered-to", "delivered_to", "envelope-to"),
    hdrTo,
  ].flatMap((s) => s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((s) => s.toLowerCase());
  let text = pick(f, "text", "text/plain", "body");
  if (!text) text = htmlToText(pick(f, "html", "htmlbody", "bodyhtml"));
  const ar = authResults(pick(f, "authentication-results", "auth-results", "headers"));
  return {
    from,
    subject: pick(f, "subject").slice(0, 500),
    text: text.slice(0, 50_000),
    messageId: pick(f, "message-id", "message_id") || null,
    inReplyTo: null,
    recipients: [...new Set(recipients)],
    dmarc: ar.dmarc, spf: ar.spf, dkim: ar.dkim,
  };
};

/** Returns the list of messages in the request — Brevo `items` or a single flat payload. */
async function parseRequest(req: Request): Promise<Parsed[] | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.clone().json().catch(() => null)) as Record<string, unknown> | null;
    if (j && Array.isArray(j.items)) {
      return j.items.slice(0, MAX_ITEMS)
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map(brevoItem).filter((p): p is Parsed => p !== null);
    }
  }
  const f = await flatFields(req);
  if (!f) return null;
  const p = flatParsed(f);
  return p ? [p] : null;
}

// ── Logging ─────────────────────────────────────────────────────────────────

type Db = NonNullable<ReturnType<typeof serviceClient>>;

async function logInbound(db: Db | null, row: Record<string, unknown>) {
  if (!db) return null;
  const { data, error } = await db.from("inbound_emails").insert(row).select("id").single();
  if (error) return error.code === "23505" ? "duplicate" as const : null;
  return (data as { id: string } | null)?.id ?? null;
}

const updateLog = (db: Db | null, id: string | null, patch: Record<string, unknown>) =>
  id && db ? db.from("inbound_emails").update(patch).eq("id", id) : Promise.resolve({ error: null });

// ── Per-message processing ──────────────────────────────────────────────────

type Outcome = { status: string; reason: string | null; ticket?: string; authMethod?: string };

async function processOne(ctx: NonNullable<Awaited<ReturnType<typeof defaultCtx>>>, db: Db | null, mail: Parsed, started: number): Promise<Outcome> {
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
  if (!body) return finish("ignored", "empty_body");

  // ── Reply-token path: every provider-supplied recipient is scanned; the
  // HMAC makes the token self-authenticating regardless of which header
  // carried it (envelope, To, or forwarded-original headers). ──
  const plusCandidates: { plus: PlusReply; ticket: Awaited<ReturnType<typeof ctx.repo.getTicketByNumber>> }[] = [];
  for (const r of mail.recipients) {
    const plus = parsePlusReply(r);
    if (!plus) continue;
    const ticket = await ctx.repo.getTicketByNumber(plus.number);
    if (ticket && verifyReplyToken(ticket.number, ticket.email, ticket.orgId, plus.token)) {
      plusCandidates.push({ plus, ticket });
    }
  }
  if (plusCandidates.length) {
    const { ticket } = plusCandidates[0];
    if (mail.from !== ticket!.email.toLowerCase()) {
      return finish("quarantined", "sender_mismatch", { ticket_number: ticket!.number, auth_method: "reply_token" });
    }
    try {
      await requesterMessage(ctx, { kind: "customer", email: mail.from }, ticket!.number, body);
      return finish("accepted", null, { ticket_number: ticket!.number, auth_method: "reply_token" });
    } catch (e) {
      if (e instanceof HelpdeskError) return finish("ignored", e.code, { ticket_number: ticket!.number, auth_method: "reply_token" });
      return finish("error", "processing_error", { ticket_number: ticket!.number, auth_method: "reply_token" });
    }
  }
  // Plus-addresses were present but none verified → suspicious, quarantine.
  if (mail.recipients.some((r) => parsePlusReply(r))) {
    return finish("quarantined", "bad_reply_token");
  }

  // ── Legacy fallback: Z-<n> reference + sender match ──────────────────────
  const num = (mail.subject.match(TICKET_RE) ?? mail.text.slice(0, 500).match(TICKET_RE))?.[0].toUpperCase();
  if (!num) return finish("ignored", "no_ticket_reference");
  const ticket = await ctx.repo.getTicketByNumber(num);
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
    await requesterMessage(ctx, actor, num, body);
    return finish("accepted", null, { ticket_number: num, auth_method: "legacy_from_match" });
  } catch (e) {
    if (e instanceof HelpdeskError) return finish("ignored", e.code, { ticket_number: num, auth_method: "legacy_from_match" });
    return finish("error", "processing_error", { ticket_number: num, auth_method: "legacy_from_match" });
  }
}

export async function POST(req: Request) {
  const started = Date.now();
  if (!secrets().length) return NextResponse.json({ error: "Inbound email not configured" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const mails = await parseRequest(req);
  const db = serviceClient();
  if (!mails || !mails.length) {
    await logInbound(db, { status: "ignored", reason: "unparseable", processed_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  const ctx = await defaultCtx();
  if (!ctx) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const results: Outcome[] = [];
  for (const mail of mails) {
    try {
      results.push(await processOne(ctx, db, mail, started));
    } catch {
      results.push({ status: "error", reason: "processing_error" });
    }
  }
  const accepted = results.filter((r) => r.status === "accepted").length;
  return NextResponse.json({ ok: true, processed: results.length, accepted, results: results.map((r) => ({ status: r.status, ticket: r.ticket, reason: r.reason })) });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
