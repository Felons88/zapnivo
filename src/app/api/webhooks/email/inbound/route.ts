import { timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { runInboundWorker } from "@/lib/inbound/worker";
import type { Parsed } from "@/lib/inbound/processor";

/**
 * Inbound email webhook — Stage A: fast durable ingestion.
 *
 * Authenticates the provider, enforces size limits, normalizes each message
 * (Brevo `items[]` or flat JSON/form), persists every valid message to the
 * durable `inbound_jobs` queue, and acks immediately. All ticket matching,
 * token verification, AI, and outbound email happen asynchronously in the
 * worker (/api/cron/inbound, plus a post-response kick via after()).
 *
 * Payload: https://developers.brevo.com/docs/inbound-parse-webhooks
 *
 * Auth layers:
 *  1. Shared secret — EMAIL_INBOUND_SECRET (comma-separated for rotation) via
 *     `?key=`, `Authorization: Bearer`, or `X-Zapnivo-Inbound-Key`. Brevo
 *     inbound webhooks are configured (ID 2672275) to send the secret as the
 *     X-Zapnivo-Inbound-Key header — it never appears in the URL.
 *  2. Reply token / sender / DMARC checks happen in Stage B per message.
 *
 * Dedupe: message_id unique index on inbound_jobs; content-hash dedupe in the
 * processor. Per-item outcomes are auditable in inbound_emails.
 */

const MAX_BODY_BYTES = 2_000_000;
const MAX_ITEMS = 50;

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

const emailOf = (raw: string) => raw.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;

const htmlToText = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").trim();

type Fields = Record<string, string>;

const pick = (f: Fields, ...names: string[]) => { for (const n of names) if (f[n]) return f[n]; return ""; };

const headerValues = (h: Record<string, unknown>, name: string): string[] => {
  const v = h[name] ?? h[name.toLowerCase()];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
};

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

const AUTO_SUBJECT_RE = /delivery status notification|undeliverable|out of office|automatic reply|auto-?reply|mail delivery (failed|subsystem)/i;

/** Detects autoresponders/delivery notifications so we never reply to them (loop prevention). */
const detectAutoSubmitted = (headers: Record<string, unknown>, subject: string, contentType?: string): boolean => {
  const hv = (n: string) => headerValues(headers, n).join(" ").toLowerCase();
  const auto = hv("Auto-Submitted");
  if (auto && auto !== "no") return true;
  if (["bulk", "junk", "list"].includes(hv("Precedence").trim())) return true;
  if (/multipart\/report|delivery-status/i.test(contentType ?? hv("Content-Type"))) return true;
  return AUTO_SUBJECT_RE.test(subject);
};

// ── Brevo item → Parsed ─────────────────────────────────────────────────────

const brevoItem = (it: Record<string, unknown>): Parsed | null => {
  const from = mailboxAddr(it.From ?? it.from);
  if (!from) return null;

  const recipients: string[] = [];
  const push = (addr: string | null) => { if (addr && !recipients.includes(addr)) recipients.push(addr); };

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
  const subject = String(it.Subject ?? "").slice(0, 500);

  return {
    from,
    subject,
    autoSubmitted: detectAutoSubmitted(headers, subject),
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
  const subject = pick(f, "subject").slice(0, 500);
  return {
    from,
    subject,
    autoSubmitted: detectAutoSubmitted(
      { "Auto-Submitted": pick(f, "auto-submitted"), Precedence: pick(f, "precedence"), "Content-Type": pick(f, "content-type") },
      subject,
    ),
    text: text.slice(0, 50_000),
    messageId: pick(f, "message-id", "message_id") || null,
    inReplyTo: null,
    recipients: [...new Set(recipients)],
    dmarc: ar.dmarc, spf: ar.spf, dkim: ar.dkim,
  };
};

/** Returns the list of normalized messages — Brevo `items` or a single flat payload. */
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

export async function POST(req: Request) {
  const started = Date.now();
  if (!secrets().length) return NextResponse.json({ error: "Inbound email not configured" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const mails = await parseRequest(req);
  const db = serviceClient();
  if (!mails || !mails.length) {
    if (db) await db.from("inbound_emails").insert({ status: "ignored", reason: "unparseable", processed_ms: Date.now() - started });
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  // Stage A: durable persistence only. Each message becomes a job; the
  // message_id unique index makes redelivery idempotent at enqueue time.
  let queued = 0, duplicates = 0;
  if (db) {
    for (const mail of mails) {
      const { error } = await db.from("inbound_jobs").insert({
        kind: "email_message",
        payload: mail as unknown as Record<string, unknown>,
        message_id: mail.messageId,
        dedupe_hash: null,
      });
      if (error?.code === "23505") duplicates++;
      else if (!error) queued++;
    }
  } else {
    // No DB: process inline as a dev fallback so local flows still work.
    const { defaultCtx } = await import("@/lib/helpdesk/service");
    const { processInboundMail } = await import("@/lib/inbound/processor");
    const ctx = await defaultCtx();
    const results = [];
    if (ctx) for (const mail of mails) results.push(await processInboundMail(ctx, null, mail));
    return NextResponse.json({ ok: true, processed: mails.length, accepted: results.filter((r) => r.status === "accepted").length, results: results.map((r) => ({ status: r.status, ticket: r.ticket, reason: r.reason })) });
  }

  // Post-response kick: drain the queue in this same deployment. The cron
  // worker is the durable backstop if this invocation is cut short. after()
  // requires a request scope — outside one (tests) we skip the kick.
  try {
    after(async () => {
      try { await runInboundWorker(25); } catch { /* cron retries */ }
    });
  } catch { /* no request scope */ }

  return NextResponse.json({ ok: true, queued, duplicates, processed: 0 });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
