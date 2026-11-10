import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { defaultCtx, requesterMessage } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";
import { serviceClient } from "@/lib/supabase";

/**
 * Inbound email webhook — turns replies to support@zapnivo.com into ticket messages.
 *
 * Provider setup (manual): configure Brevo Inbound Parsing (or any provider that
 * POSTs parsed mail) to https://api.zapnivo.com/webhooks/email/inbound?key=$EMAIL_INBOUND_SECRET
 * with the parsing domain's MX pointed at the provider. Only mail sent to the
 * support mailbox should be forwarded here — the other 10 sender identities are
 * outbound-only and must not be wired to this endpoint.
 *
 * Accepts Brevo inbound-parse fields (from/subject/text/html, case-insensitive,
 * form or JSON) or a simple JSON {from,subject,text,html} shape.
 *
 * Security: shared-secret key + the reply must come from the ticket requester's
 * email (assertOwner inside requesterMessage). Anything else is silently ignored
 * with 200 so providers don't retry-loop.
 */

const authorized = (req: Request) => {
  const secret = process.env.EMAIL_INBOUND_SECRET;
  if (!secret) return false;
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = `Bearer ${secret}`;
  if (eq(req.headers.get("authorization") ?? "", bearer)) return true;
  return eq(new URL(req.url).searchParams.get("key") ?? "", secret);
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const TICKET_RE = /\bZ-\d+\b/i;

const fromAddress = (raw: string) => {
  const m = raw.match(/<([^>]+)>/);
  const candidate = (m?.[1] ?? raw).trim();
  return candidate.match(EMAIL_RE)?.[0].toLowerCase() ?? null;
};

/** Drops quoted reply history so the ticket only stores the new message. */
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

type Parsed = { from: string; subject: string; text: string };

async function parseInbound(req: Request): Promise<Parsed | null> {
  const ct = req.headers.get("content-type") ?? "";
  const fields: Record<string, string> = {};
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j !== "object") return null;
    for (const [k, v] of Object.entries(j)) if (typeof v === "string") fields[k.toLowerCase()] = v;
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) if (typeof v === "string") fields[k.toLowerCase()] = v;
  }
  const pick = (...names: string[]) => { for (const n of names) if (fields[n]) return fields[n]; return ""; };
  const fromRaw = pick("from", "sender");
  const from = fromAddress(fromRaw);
  if (!from) return null;
  const subject = pick("subject");
  let text = pick("text", "text/plain", "body");
  if (!text) text = htmlToText(pick("html", "htmlbody", "bodyhtml"));
  return { from, subject, text };
}

export async function POST(req: Request) {
  if (!process.env.EMAIL_INBOUND_SECRET) return NextResponse.json({ error: "Inbound email not configured" }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mail = await parseInbound(req);
  if (!mail) return NextResponse.json({ ok: true, ignored: "unparseable" });

  const num = (mail.subject.match(TICKET_RE) ?? mail.text.slice(0, 500).match(TICKET_RE))?.[0].toUpperCase();
  if (!num) return NextResponse.json({ ok: true, ignored: "no_ticket_reference" });

  const ctx = await defaultCtx();
  if (!ctx) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const ticket = await ctx.repo.getTicketByNumber(num);
  if (!ticket) return NextResponse.json({ ok: true, ignored: "unknown_ticket" });

  // Resolve the strongest actor the sender email proves: partner profile →
  // partner actor (org-scoped), otherwise customer actor (email-verified by
  // assertOwner against the ticket requester's address).
  const db = serviceClient();
  let actor: Parameters<typeof requesterMessage>[1] = { kind: "customer", email: mail.from };
  if (ticket.requesterType === "partner" && db) {
    const { data: p } = await db.from("profiles").select("id,role,organization_id,full_name").ilike("email", mail.from).maybeSingle();
    const prof = p as { id: string; role: string; organization_id: string | null; full_name: string | null } | null;
    if (prof?.role === "partner" && prof.organization_id && prof.organization_id === ticket.orgId) {
      actor = { kind: "partner", id: prof.id, name: prof.full_name ?? mail.from, email: mail.from, orgId: prof.organization_id };
    }
  }

  const body = stripQuoted(mail.text).slice(0, 2000);
  if (!body) return NextResponse.json({ ok: true, ignored: "empty_body" });

  try {
    await requesterMessage(ctx, actor, num, body);
    return NextResponse.json({ ok: true, ticket: num });
  } catch (e) {
    if (e instanceof HelpdeskError) return NextResponse.json({ ok: true, ignored: e.code });
    throw e;
  }
}
