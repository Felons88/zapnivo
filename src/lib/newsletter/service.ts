import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "../observability";
import { serviceClient } from "../supabase";
import { SITE } from "../site";
import { getRepo } from "../helpdesk/repo";
import { flushOutbox, getMailer } from "../helpdesk/mailer";
import {
  NEWSLETTER_CONSENT_TEXT,
  NEWSLETTER_CONSENT_VERSION,
  decideSubscribe,
  mergeSegments,
  type NewsletterSegment,
  type NewsletterStatus,
  type NewsletterSubscribeInput,
  type SubscriberState,
} from "./core";

/**
 * Newsletter subscriber pipeline — server-only.
 *
 * Double opt-in: subscribe → status 'pending' + confirm-token hash → branded DOI
 * email (helpdesk outbox → Resend/Brevo) → /api/newsletter/confirm flips to
 * 'confirmed'. Pending rows are NEVER counted as subscribers.
 * Tokens are stored as SHA-256 hashes only; raw tokens live only in emailed links.
 * Delivery failures leave the row 'pending' and are logged — never faked.
 */

export const COLS =
  "id,email,segment,status,confirm_token_hash,confirmed_at,unsubscribe_token_hash,unsubscribed_at,source,consent_text_version,consent_at,created_at,updated_at";

export type SubscriberRow = {
  id: string;
  email: string;
  segment: NewsletterSegment;
  status: NewsletterStatus;
  confirm_token_hash: string | null;
  confirmed_at: string | null;
  unsubscribe_token_hash: string | null;
  unsubscribed_at: string | null;
  source: string;
  consent_text_version: string | null;
  consent_at: string | null;
  created_at: string;
  updated_at: string;
};

/* ── Tokens ────────────────────────────────────────────────────────────────── */

const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const siteBase = () => SITE.url.replace(/\/$/, "");
export const confirmUrl = (token: string) => `${siteBase()}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
export const unsubscribeUrl = (token: string) => `${siteBase()}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;

/* ── Email (branded, self-contained — no registered template exists for this) ── */

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function doiEmail(kind: "confirm" | "welcome", vars: { confirmUrl?: string; unsubscribeUrl: string; year: number }) {
  const isConfirm = kind === "confirm";
  const headline = isConfirm ? "Confirm your subscription" : "You're on the list";
  const body = isConfirm
    ? "You asked to hear from Zapnivo. Confirm your email to finish subscribing — the link expires only if you never use it."
    : "Your Zapnivo subscription is confirmed. Watch your inbox for occasional station news, rental tips, and product updates.";
  const cta = isConfirm
    ? `<a href="${esc(vars.confirmUrl!)}" style="display:inline-block;background:#d9ff73;color:#11122b;padding:15px 26px;border-radius:10px;font-weight:800;font-size:14px;text-decoration:none">Confirm subscription →</a>`
    : "";
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f1f4ed;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f4ed"><tr><td align="center" style="padding:34px 16px 42px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px">
<tr><td style="padding:0 3px 22px"><span style="font-size:25px;font-weight:900;color:#182319;letter-spacing:-1.6px">ZAP<span style="color:#719f0d">NIVO</span></span></td></tr>
<tr><td style="background:#11122b;border-radius:16px;padding:35px 37px">
<span style="color:#d9ff73;font-size:10px;font-weight:800;letter-spacing:2.4px">NEWSLETTER</span>
<h1 style="margin:20px 0 12px;font-size:34px;font-weight:800;line-height:1.1;letter-spacing:-1px;color:#fff">${headline}</h1>
<p style="margin:0;color:#c7d2c8;font-size:15px;line-height:1.75">${body}</p>
${isConfirm ? `<div style="margin-top:26px">${cta}</div><p style="margin:18px 0 0;color:#8b93b8;font-size:12px;line-height:1.7">Button not working? Paste this link into your browser:<br><a href="${esc(vars.confirmUrl!)}" style="color:#d9ff73">${esc(vars.confirmUrl!)}</a></p>` : ""}
</td></tr>
<tr><td style="background:#fff;padding:24px 37px;border-radius:0 0 16px 16px">
<p style="margin:0;font-size:12px;line-height:1.8;color:#647064">You received this because someone subscribed this address at zapnivo.com.
<a href="${esc(vars.unsubscribeUrl)}" style="color:#406027">Unsubscribe anytime</a> — no login needed.</p>
<p style="margin:14px 0 0;color:#8a9588;font-size:11px">Life moves. Power follows. · © ${vars.year} Zapnivo</p>
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    headline,
    "",
    body,
    ...(isConfirm ? ["", `Confirm: ${vars.confirmUrl}`, ""] : []),
    `Unsubscribe anytime: ${vars.unsubscribeUrl}`,
    "",
    "— Zapnivo · Life moves. Power follows.",
  ].join("\n");
  return { html, text };
}

/** Queues the DOI/welcome email into the outbox and flushes via the configured provider. Never throws. */
async function sendNewsletterEmail(to: string, kind: "confirm" | "welcome", links: { confirmUrl?: string; unsubscribeUrl: string }) {
  try {
    const repo = await getRepo();
    if (!repo) {
      recordLog("warning", "newsletter_email_no_repo", { service: "newsletter", attrs: { kind } });
      return { queued: false, reason: "no_repo" as const };
    }
    const mail = doiEmail(kind, { ...links, year: new Date().getFullYear() });
    const subject = kind === "confirm" ? "Confirm your Zapnivo subscription" : "You're subscribed to Zapnivo";
    const row = await repo.queueEmail({
      ticketId: null,
      to,
      subject,
      body: mail.text,
      html: mail.html,
      sender: "notifications",
      replyTo: null,
      template: null,
      event: kind === "confirm" ? "newsletter.confirm" : "newsletter.welcome",
    });
    const mailer = getMailer();
    if (!mailer) {
      // Honest: row stays 'queued' in the outbox until a provider is configured.
      recordLog("warning", "newsletter_email_no_provider", { service: "newsletter", attrs: { kind } });
      return { queued: true, sent: false, reason: "no_provider" as const };
    }
    const res = await flushOutbox(repo, mailer);
    const sent = res.sentIds.includes(row.id);
    if (!sent) recordLog("error", "newsletter_email_send_failed", { service: "newsletter", attrs: { kind, outboxId: row.id } });
    return { queued: true, sent, reason: sent ? null : ("send_failed" as const) };
  } catch (err) {
    recordLog("error", "newsletter_email_error", {
      service: "newsletter",
      attrs: { kind, message: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
    });
    return { queued: false, sent: false, reason: "error" as const };
  }
}

/* ── Business-event analytics (first-party pipeline; no PII in props) ───────── */

function recordNewsletterEvent(db: SupabaseClient | null, e: {
  name: "newsletter_subscribed" | "newsletter_confirmed" | "newsletter_unsubscribed";
  subscriberId: string;
  segment?: NewsletterSegment;
  source?: string;
}) {
  try {
    if (!db) return;
    void db.from("business_events").insert({
      name: e.name,
      source: "server",
      entity_type: "newsletter_subscriber",
      entity_id: e.subscriberId,
      props: { segment: e.segment ?? null, source: e.source ?? null },
      privacy_class: "internal",
      consent_state: "granted",
    }).then(() => undefined, () => undefined);
  } catch { /* analytics must never break the request */ }
}

/* ── Brevo audience sync (optional — requires NEWSLETTER_BREVO_LIST_ID) ─────── */

/**
 * Best-effort Brevo contact upsert into the configured list. The transactional
 * DOI path works without this; audience sync is a bonus layer. Returns an honest
 * status — never throws, never claims a sync that didn't happen.
 */
export async function syncBrevoAudience(email: string, segment: NewsletterSegment, status: NewsletterStatus) {
  const key = process.env.BREVO_API_KEY;
  const listId = Number(process.env.NEWSLETTER_BREVO_LIST_ID);
  if (!key || !Number.isFinite(listId) || listId <= 0) {
    return { synced: false as const, reason: "not_configured" as const };
  }
  try {
    const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
      headers: { "api-key": key, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        email,
        attributes: { SEGMENT: segment, STATUS: status, SOURCE: "zapnivo_website" },
        listIds: [listId],
        updateEnabled: true,
      }),
    });
    if (!res.ok) {
      recordLog("error", "newsletter_brevo_sync_failed", { service: "newsletter", attrs: { status: res.status } });
      return { synced: false as const, reason: "provider_error" as const };
    }
    return { synced: true as const, reason: null };
  } catch (err) {
    recordLog("error", "newsletter_brevo_sync_error", {
      service: "newsletter",
      attrs: { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
    });
    return { synced: false as const, reason: "provider_error" as const };
  }
}

/* ── Store helpers ──────────────────────────────────────────────────────────── */

async function findByEmail(db: SupabaseClient, email: string): Promise<SubscriberRow | null> {
  const { data, error } = await db.from("newsletter_subscribers").select(COLS).eq("email", email).maybeSingle();
  if (error) throw new Error(`newsletter_lookup:${error.message}`);
  return (data as SubscriberRow | null) ?? null;
}

async function findByTokenHash(db: SupabaseClient, column: "confirm_token_hash" | "unsubscribe_token_hash", hash: string): Promise<SubscriberRow | null> {
  const { data, error } = await db.from("newsletter_subscribers").select(COLS).eq(column, hash).maybeSingle();
  if (error) throw new Error(`newsletter_token_lookup:${error.message}`);
  return (data as SubscriberRow | null) ?? null;
}

/** Business-interest lead into the existing staff intake queue (partner_applications needs fields we don't have). */
async function recordPartnerLead(db: SupabaseClient, email: string, segment: NewsletterSegment) {
  try {
    await db.from("contact_messages").insert({
      queue: "venue_partnerships",
      name: "Newsletter business signup",
      email,
      message: `Business newsletter signup (${segment}) via the website popup. This address asked for partnership updates — follow up through the partnerships channel.`,
    });
  } catch (err) {
    recordLog("warning", "newsletter_partner_lead_failed", {
      service: "newsletter",
      attrs: { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
    });
  }
}

const includesBusiness = (s: NewsletterSegment) => s === "business" || s === "both";

/* ── Public operations ──────────────────────────────────────────────────────── */

export type SubscribeResult =
  | { ok: true; action: "created" | "resent" | "updated" | "resubscribed" }
  | { ok: false; status: number; error: string };

/**
 * Handles POST /api/newsletter/subscribe. Always returns the same generic success
 * shape for valid emails (no account enumeration); real failures are honest 5xx/503.
 */
export async function subscribe(input: NewsletterSubscribeInput): Promise<SubscribeResult> {
  const db = serviceClient();
  if (!db) return { ok: false, status: 503, error: "Newsletter signup is not available yet." };

  const email = input.email.toLowerCase();
  const existing = await findByEmail(db, email);
  const decision = decideSubscribe(
    existing ? { status: existing.status, segment: existing.segment } : null,
    input.segment,
  );
  // Snapshot BEFORE any update mutates state: did this address already express
  // business interest? Used to avoid duplicate partner leads.
  const prevHadBusiness = existing ? includesBusiness(existing.segment) : false;

  const confirmTok = newToken();
  const unsubTok = newToken();
  const now = new Date().toISOString();
  const needsDoi = decision.action === "create" || decision.action === "resend_pending" || decision.action === "resubscribe";
  const tokenPatch = needsDoi
    ? {
        confirm_token_hash: hashToken(confirmTok),
        unsubscribe_token_hash: hashToken(unsubTok),
        consent_text_version: NEWSLETTER_CONSENT_VERSION,
        consent_at: now,
      }
    : {};

  let row: SubscriberRow;
  if (decision.action === "create") {
    const { data, error } = await db.from("newsletter_subscribers").insert({
      email,
      segment: decision.segment,
      status: "pending",
      source: input.source ?? "website_popup",
      ...tokenPatch,
    }).select(COLS).single();
    if (error || !data) {
      recordLog("error", "newsletter_insert_failed", { service: "newsletter", attrs: { code: error?.code } });
      return { ok: false, status: 500, error: "We couldn't save your subscription. Please try again." };
    }
    row = data as SubscriberRow;
  } else {
    const patch: Record<string, unknown> = {
      segment: decision.segment,
      updated_at: now,
      ...tokenPatch,
    };
    if (decision.action === "resubscribe") {
      patch.status = "pending";
      patch.confirmed_at = null;
      patch.unsubscribed_at = null;
    }
    const { data, error } = await db.from("newsletter_subscribers")
      .update(patch).eq("id", existing!.id).select(COLS).single();
    if (error || !data) {
      recordLog("error", "newsletter_update_failed", { service: "newsletter", attrs: { code: error?.code } });
      return { ok: false, status: 500, error: "We couldn't save your subscription. Please try again." };
    }
    row = data as SubscriberRow;
  }

  // Partner lead: only when the effective segment includes business and the
  // previous state didn't already capture that interest.
  if (includesBusiness(decision.segment) && !prevHadBusiness) {
    await recordPartnerLead(db, email, decision.segment);
  }

  if (needsDoi) {
    await sendNewsletterEmail(email, "confirm", {
      confirmUrl: confirmUrl(confirmTok),
      unsubscribeUrl: unsubscribeUrl(unsubTok),
    });
  }

  recordNewsletterEvent(db, {
    name: "newsletter_subscribed",
    subscriberId: row.id,
    segment: row.segment,
    source: row.source,
  });
  recordLog("info", "newsletter_subscribed", { service: "newsletter", attrs: { action: decision.action, segment: row.segment } });

  return {
    ok: true,
    action:
      decision.action === "create" ? "created"
      : decision.action === "resend_pending" ? "resent"
      : decision.action === "resubscribe" ? "resubscribed"
      : "updated",
  };
}

export type ConfirmResult = { ok: true; status: "confirmed" | "already_confirmed" } | { ok: false; status: number; error: string };

/** GET /api/newsletter/confirm?token= — flips pending → confirmed. Idempotent. */
export async function confirmSubscription(rawToken: string): Promise<ConfirmResult> {
  const db = serviceClient();
  if (!db) return { ok: false, status: 503, error: "Newsletter service is not available yet." };
  const token = rawToken.trim();
  if (token.length < 20 || token.length > 200) return { ok: false, status: 400, error: "Invalid confirmation link." };

  const row = await findByTokenHash(db, "confirm_token_hash", hashToken(token));
  if (!row) return { ok: false, status: 404, error: "This confirmation link is invalid or has already been used." };
  if (row.status === "unsubscribed") return { ok: false, status: 410, error: "This subscription was cancelled. Subscribe again to restart it." };
  if (row.status === "confirmed") return { ok: true, status: "already_confirmed" };

  const now = new Date().toISOString();
  const { error } = await db.from("newsletter_subscribers")
    .update({ status: "confirmed", confirmed_at: now, updated_at: now })
    .eq("id", row.id).eq("status", "pending"); // compare-and-set
  if (error) {
    recordLog("error", "newsletter_confirm_failed", { service: "newsletter", attrs: { code: error.code } });
    return { ok: false, status: 500, error: "We couldn't confirm your subscription. Please try again." };
  }

  // Best-effort: Brevo audience sync + welcome email with the unsubscribe link.
  void syncBrevoAudience(row.email, row.segment, "confirmed");
  if (row.unsubscribe_token_hash) {
    // The raw unsubscribe token is NOT recoverable from the hash — issue a fresh
    // one for the welcome email so the recipient always has a working opt-out.
    const unsubTok = newToken();
    await db.from("newsletter_subscribers")
      .update({ unsubscribe_token_hash: hashToken(unsubTok) })
      .eq("id", row.id);
    await sendNewsletterEmail(row.email, "welcome", { unsubscribeUrl: unsubscribeUrl(unsubTok) });
  }

  recordNewsletterEvent(db, { name: "newsletter_confirmed", subscriberId: row.id, segment: row.segment });
  recordLog("info", "newsletter_confirmed", { service: "newsletter", attrs: { segment: row.segment } });
  return { ok: true, status: "confirmed" };
}

export type UnsubscribeResult = { ok: true } | { ok: false; status: number; error: string };

/** POST /api/newsletter/unsubscribe?token= — token-authenticated opt-out. No login. */
export async function unsubscribeSubscription(rawToken: string): Promise<UnsubscribeResult> {
  const db = serviceClient();
  if (!db) return { ok: false, status: 503, error: "Newsletter service is not available yet." };
  const token = rawToken.trim();
  if (token.length < 20 || token.length > 200) return { ok: false, status: 400, error: "Invalid unsubscribe link." };

  const row = await findByTokenHash(db, "unsubscribe_token_hash", hashToken(token));
  if (!row) return { ok: false, status: 404, error: "This unsubscribe link is invalid or has already been used." };
  if (row.status === "unsubscribed") return { ok: true }; // idempotent

  const now = new Date().toISOString();
  // Burn both tokens — a used opt-out link must never remain live.
  const { error } = await db.from("newsletter_subscribers")
    .update({ status: "unsubscribed", unsubscribed_at: now, confirm_token_hash: null, unsubscribe_token_hash: null, updated_at: now })
    .eq("id", row.id);
  if (error) {
    recordLog("error", "newsletter_unsubscribe_failed", { service: "newsletter", attrs: { code: error.code } });
    return { ok: false, status: 500, error: "We couldn't unsubscribe you. Please try again." };
  }

  void syncBrevoAudience(row.email, row.segment, "unsubscribed");
  recordNewsletterEvent(db, { name: "newsletter_unsubscribed", subscriberId: row.id, segment: row.segment });
  recordLog("info", "newsletter_unsubscribed", { service: "newsletter", attrs: { segment: row.segment } });
  return { ok: true };
}

/* ── Admin operations ───────────────────────────────────────────────────────── */

export type NewsletterOverview = {
  totals: Record<NewsletterStatus, number>;
  bySegment: Record<NewsletterSegment, Record<NewsletterStatus, number>>;
  confirmedTotal: number;
  recent: SubscriberRow[];
};

const emptyMatrix = (): Record<NewsletterSegment, Record<NewsletterStatus, number>> => ({
  customer: { pending: 0, confirmed: 0, unsubscribed: 0 },
  business: { pending: 0, confirmed: 0, unsubscribed: 0 },
  both: { pending: 0, confirmed: 0, unsubscribed: 0 },
});

/** Staff stats: pending rows are reported but NEVER counted as subscribers. */
export async function getNewsletterOverview(db: SupabaseClient | null, recentLimit = 50): Promise<NewsletterOverview | null> {
  if (!db) return null;
  const { data, error } = await db.from("newsletter_subscribers").select(COLS).order("created_at", { ascending: false }).limit(10000);
  if (error || !Array.isArray(data)) return null;
  const rows = data as SubscriberRow[];
  const totals: Record<NewsletterStatus, number> = { pending: 0, confirmed: 0, unsubscribed: 0 };
  const bySegment = emptyMatrix();
  for (const r of rows) {
    totals[r.status] += 1;
    bySegment[r.segment][r.status] += 1;
  }
  return {
    totals,
    bySegment,
    confirmedTotal: totals.confirmed,
    recent: rows.slice(0, recentLimit),
  };
}

/** Manual DOI resend (staff). Only pending rows can be re-sent a confirm link. */
export async function resendConfirmation(db: SupabaseClient, id: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data, error } = await db.from("newsletter_subscribers").select(COLS).eq("id", id).maybeSingle();
  if (error) return { ok: false, status: 500, error: "Lookup failed" };
  const row = data as SubscriberRow | null;
  if (!row) return { ok: false, status: 404, error: "Subscriber not found" };
  if (row.status !== "pending") return { ok: false, status: 409, error: `Subscriber is ${row.status} — only pending rows can be resent a confirmation.` };

  const confirmTok = newToken();
  const unsubTok = newToken();
  const { error: upErr } = await db.from("newsletter_subscribers").update({
    confirm_token_hash: hashToken(confirmTok),
    unsubscribe_token_hash: hashToken(unsubTok),
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (upErr) return { ok: false, status: 500, error: "Update failed" };

  await sendNewsletterEmail(row.email, "confirm", {
    confirmUrl: confirmUrl(confirmTok),
    unsubscribeUrl: unsubscribeUrl(unsubTok),
  });
  recordLog("info", "newsletter_confirm_resent", { service: "newsletter", attrs: { segment: row.segment } });
  return { ok: true };
}

export { NEWSLETTER_CONSENT_TEXT };
