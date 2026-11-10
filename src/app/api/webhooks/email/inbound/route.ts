import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { defaultCtx, requesterMessage } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";
import { parsePlusReply, verifyReplyToken } from "@/lib/email/inbound";
import { serviceClient } from "@/lib/supabase";

/**
 * Inbound email webhook — turns replies to support@/partners@zapnivo.com into
 * ticket messages. Provider setup: docs/DEPLOYMENT.md "Email routing & inbound".
 *
 * Auth layers (defense in depth):
 *  1. Shared secret — EMAIL_INBOUND_SECRET (comma-separated list supported for
 *     rotation). Accepted via `?key=`, `Authorization: Bearer`, or
 *     `X-Zapnivo-Inbound-Key`. Brevo inbound parsing cannot sign requests, so
 *     the secret + TLS is the provider authentication; it is never logged.
 *  2. Reply token — outbound ticket emails carry `support+<TICKET>-<hmac>`
 *     Reply-To addresses; the token must verify against the ticket's
 *     number+requester email+org before the message is accepted.
 *  3. Sender match — From must equal the ticket requester's email.
 *  4. Legacy fallback — subject `Z-<n>` + From match for mail sent before
 *     tokens existed (recorded as auth_method=legacy_from_match).
 *  5. DMARC — provider Authentication-Results with dmarc=fail quarantines.
 *
 * Every request is logged to inbound_emails (dedupe by Message-ID, then by
 * content hash) — accepted, quarantined, rejected, ignored, duplicate, error.
 */

const MAX_BODY_BYTES = 2_000_000;
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

const fromAddress = (raw: string) => {
  const m = raw.match(/<([^>]+)>/);
  const candidate = (m?.[1] ?? raw).trim();
  return candidate.match(EMAIL_RE)?.[0].toLowerCase() ?? null;
};

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

type Fields = Record<string, string>;
type Parsed = {
  from: string; subject: string; text: string;
  messageId: string | null; to: string | null; deliveredTo: string | null;
  dmarc: string | null; spf: string | null; dkim: string | null;
};

const pick = (f: Fields, ...names: string[]) => { for (const n of names) if (f[n]) return f[n]; return ""; };

/** Pulls spf/dkim/dmarc results out of an Authentication-Results header or JSON blob. */
const authResults = (raw: string): { dmarc: string | null; spf: string | null; dkim: string | null } => {
  if (!raw) return { dmarc: null, spf: null, dkim: null };
  let hay = raw;
  try { const j = JSON.parse(raw); if (j && typeof j === "object") hay = JSON.stringify(j); } catch { /* plain header text */ }
  const grab = (k: string) => hay.match(new RegExp(`${k}=(\\w+)`, "i"))?.[1]?.toLowerCase() ?? null;
  return { dmarc: grab("dmarc"), spf: grab("spf"), dkim: grab("dkim") };
};

async function parseInbound(req: Request): Promise<Parsed | null> {
  const ct = req.headers.get("content-type") ?? "";
  const fields: Fields = {};
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j !== "object") return null;
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === "string") fields[k.toLowerCase()] = v;
      else if (v && typeof v === "object") fields[k.toLowerCase()] = JSON.stringify(v);
    }
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) if (typeof v === "string") fields[k.toLowerCase()] = v;
  }
  // Some providers nest everything under a `headers` JSON string.
  const headersRaw = pick(fields, "headers", "header");
  if (headersRaw) {
    try {
      const h = JSON.parse(headersRaw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(h)) if (typeof v === "string" && !fields[k.toLowerCase()]) fields[k.toLowerCase()] = v;
    } catch { /* not JSON — authResults handles raw text */ }
  }
  const from = fromAddress(pick(fields, "from", "sender"));
  if (!from) return null;
  let text = pick(fields, "text", "text/plain", "body");
  if (!text) text = htmlToText(pick(fields, "html", "htmlbody", "bodyhtml"));
  const ar = authResults(pick(fields, "authentication-results", "auth-results", "headers"));
  return {
    from,
    subject: pick(fields, "subject"),
    text: text.slice(0, 50_000),
    messageId: pick(fields, "message-id", "message_id") || null,
    to: pick(fields, "to", "delivered-to", "delivered_to", "envelope-to") || null,
    deliveredTo: pick(fields, "delivered-to", "delivered_to") || null,
    dmarc: ar.dmarc, spf: ar.spf, dkim: ar.dkim,
  };
}

type Db = NonNullable<ReturnType<typeof serviceClient>>;

async function logInbound(db: Db | null, row: Record<string, unknown>) {
  if (!db) return null;
  const { data, error } = await db.from("inbound_emails").insert(row).select("id").single();
  if (error) {
    if (error.code === "23505") return "duplicate" as const;
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

const updateLog = (db: Db | null, id: string | null, patch: Record<string, unknown>) =>
  id && db ? db.from("inbound_emails").update(patch).eq("id", id) : Promise.resolve({ error: null });

export async function POST(req: Request) {
  const started = Date.now();
  if (!secrets().length) return NextResponse.json({ error: "Inbound email not configured" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const mail = await parseInbound(req);
  const db = serviceClient();
  if (!mail) {
    await logInbound(db, { status: "ignored", reason: "unparseable", processed_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  const body = stripQuoted(mail.text).slice(0, 2000);
  const dedupeHash = createHash("sha256").update(`${mail.from}|${mail.subject}|${body}`).digest("hex").slice(0, 32);
  const base = {
    message_id: mail.messageId, dedupe_hash: dedupeHash, from_email: mail.from,
    to_address: mail.to ?? mail.deliveredTo, subject: mail.subject.slice(0, 500),
    dmarc_result: mail.dmarc, spf_result: mail.spf, dkim_result: mail.dkim,
    body_preview: body.slice(0, 200) || null,
  };

  // Replay protection: Message-ID unique index, then content-hash window.
  const logId = await logInbound(db, { ...base, status: "ignored", reason: "processing" });
  if (logId === "duplicate") return NextResponse.json({ ok: true, ignored: "duplicate_message_id" });
  if (db && !mail.messageId) {
    const { data: dupe } = await db.from("inbound_emails")
      .select("id").eq("dedupe_hash", dedupeHash)
      .gte("created_at", new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()).limit(1);
    if (dupe?.length) {
      await updateLog(db, logId, { status: "duplicate", reason: "content_hash", processed_ms: Date.now() - started });
      return NextResponse.json({ ok: true, ignored: "duplicate" });
    }
  }

  const finish = async (status: string, reason: string | null, extra: Record<string, unknown> = {}) => {
    await updateLog(db, typeof logId === "string" ? logId : null, { status, reason, processed_ms: Date.now() - started, ...extra });
    return NextResponse.json({ ok: status === "accepted", ...(status === "accepted" ? { ticket: extra.ticket_number } : { ignored: reason ?? status }) });
  };

  // Provider authentication results: an explicit DMARC fail quarantines the
  // message for staff review rather than dropping it silently.
  if (mail.dmarc === "fail") return finish("quarantined", "dmarc_fail");
  if (!body) return finish("ignored", "empty_body");

  const ctx = await defaultCtx();
  if (!ctx) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  // ── Layer 1+2: plus-address reply token ──────────────────────────────────
  const plus = parsePlusReply(mail.to) ?? parsePlusReply(mail.deliveredTo);
  if (plus) {
    const ticket = await ctx.repo.getTicketByNumber(plus.number);
    if (!ticket) return finish("rejected", "unknown_ticket", { ticket_number: plus.number });
    const okToken = verifyReplyToken(ticket.number, ticket.email, ticket.orgId, plus.token);
    if (!okToken) return finish("quarantined", "bad_reply_token", { ticket_number: plus.number });
    if (mail.from !== ticket.email.toLowerCase()) return finish("quarantined", "sender_mismatch", { ticket_number: plus.number, auth_method: "reply_token" });
    try {
      await requesterMessage(ctx, { kind: "customer", email: mail.from }, ticket.number, body);
      return finish("accepted", null, { ticket_number: ticket.number, auth_method: "reply_token" });
    } catch (e) {
      if (e instanceof HelpdeskError) return finish("ignored", e.code, { ticket_number: ticket.number, auth_method: "reply_token" });
      return finish("error", "processing_error", { ticket_number: ticket.number, auth_method: "reply_token" });
    }
  }

  // ── Layer 3: legacy fallback — Z-<n> reference + sender match ────────────
  const num = (mail.subject.match(TICKET_RE) ?? mail.text.slice(0, 500).match(TICKET_RE))?.[0].toUpperCase();
  if (!num) return finish("ignored", "no_ticket_reference");
  const ticket = await ctx.repo.getTicketByNumber(num);
  if (!ticket) return finish("ignored", "unknown_ticket", { ticket_number: num });

  // Resolve the strongest actor the sender email proves (partner profile →
  // org-scoped partner actor; otherwise customer email match via assertOwner).
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

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
