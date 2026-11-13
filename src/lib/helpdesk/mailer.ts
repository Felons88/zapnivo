import { EMAIL_SENDERS, resolveSender } from "../email/senders";
import { serviceClient } from "../supabase";
import type { HelpdeskRepo } from "./repo";

/**
 * Email delivery seam. Everything customer-visible is first written to the outbox (so nothing is lost
 * and the UI can show delivery state), then flushed through a Mailer. With no provider configured,
 * emails stay "queued"; the product never claims an email was sent when it wasn't.
 *
 * Provider: Resend (set RESEND_API_KEY; SUPPORT_FROM_EMAIL optional — per-message sender identities
 * from ../email/senders.ts are used when present, otherwise the "general" sender is the default From).
 * Inbound replies-by-email would arrive via a provider webhook (future) and call addCustomerMessage.
 *
 * Sender identity: a message may carry `from` (department sender from ../email/senders.ts) and
 * `replyTo`. When absent, SUPPORT_FROM_EMAIL is used; when that is also unset the registry's
 * general sender (hello@zapnivo.com) is the fallback — a From address is always resolvable.
 */
export interface Mailer {
  send(m: {
    to: string; subject: string; body: string; html?: string | null;
    from?: { name: string; email: string } | null;
    replyTo?: string | null;
  }): Promise<void>;
}

/** Registry fallback From when SUPPORT_FROM_EMAIL is unset (per-message senders still win). */
const defaultFrom = () => ({ name: EMAIL_SENDERS.general.name, email: EMAIL_SENDERS.general.email });

/** A provider key plus a resolvable From (explicit env or the registry default) = configured. */
export const mailerConfigured = () => Boolean(
  (process.env.RESEND_API_KEY || process.env.BREVO_API_KEY) &&
  (process.env.SUPPORT_FROM_EMAIL || defaultFrom().email),
);

/** "Name <email>" → { name, email }; bare address → { email }. */
const parseFrom = (raw: string) => {
  const match = raw.match(/^(.*)<([^>]+)>\s*$/);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { email: raw.trim() };
};

/** From for mail with no per-message sender: env override, else the registry default. */
const fallbackFrom = () => (process.env.SUPPORT_FROM_EMAIL ? parseFrom(process.env.SUPPORT_FROM_EMAIL) : defaultFrom());

export class ResendMailer implements Mailer {
  async send(m: { to: string; subject: string; body: string; html?: string | null; from?: { name: string; email: string } | null; replyTo?: string | null }) {
    const f = m.from ?? fallbackFrom();
    const from = "name" in f && f.name ? `${f.name} <${f.email}>` : f.email;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.body, reply_to: m.replyTo ?? undefined, ...(m.html ? { html: m.html } : {}) }),
    });
    if (!res.ok) throw new Error(`resend_${res.status}`);
  }
}

/** Brevo (Sendinblue) transactional API — set BREVO_API_KEY (SUPPORT_FROM_EMAIL optional). */
export class BrevoMailer implements Mailer {
  async send(m: { to: string; subject: string; body: string; html?: string | null; from?: { name: string; email: string } | null; replyTo?: string | null }) {
    const sender = m.from ?? fallbackFrom();
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "api-key": process.env.BREVO_API_KEY!, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender, to: [{ email: m.to }], subject: m.subject, textContent: m.body,
        ...(m.html ? { htmlContent: m.html } : {}),
        ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`brevo_${res.status}`);
  }
}

export const getMailer = (): Mailer | null => {
  if (!mailerConfigured()) return null;
  if (process.env.BREVO_API_KEY) return new BrevoMailer();
  return new ResendMailer();
};

/* ── Bounded retry of failed outbox rows ────────────────────────────────────
 * flushOutbox only picks status='queued', so a transient provider error would
 * otherwise strand a row in 'failed' until someone clicks retry in System
 * Control. This sweep requeues failed rows that are old enough to be past the
 * transient window, up to OUTBOX_MAX_RETRIES requeues (tracked in the
 * email_outbox.attempts column, migration 0057). Rows at the cap stay 'failed'
 * for manual review — getSystemJobs already surfaces the failed count.
 */
export const OUTBOX_RETRY_MIN_AGE_MS = 15 * 60_000;
export const OUTBOX_MAX_RETRIES = 5;

/** Pure decision used by the sweep (exported for tests). */
export const outboxRetryEligible = (attempts: number | null, createdAt: string, now = Date.now()) =>
  (attempts ?? 0) < OUTBOX_MAX_RETRIES && now - Date.parse(createdAt) >= OUTBOX_RETRY_MIN_AGE_MS;

/**
 * Requeues eligible failed email_outbox rows (failed → queued, attempts+1).
 * Returns the number requeued. No-ops when Supabase isn't configured (dev
 * JSON store) or the attempts column doesn't exist yet (pre-0057) — both
 * honest degradations, never thrown.
 */
export async function requeueFailedOutbox(now = Date.now()): Promise<number> {
  const db = serviceClient();
  if (!db) return 0;
  const cutoff = new Date(now - OUTBOX_RETRY_MIN_AGE_MS).toISOString();
  const { data, error } = await db.from("email_outbox")
    .select("id,attempts,created_at").eq("status", "failed").lt("created_at", cutoff).limit(50);
  if (error || !data?.length) return 0;
  let n = 0;
  for (const r of data as { id: string; attempts: number | null; created_at: string }[]) {
    if (!outboxRetryEligible(r.attempts, r.created_at, now)) continue;
    const { error: upErr } = await db.from("email_outbox")
      .update({ status: "queued", error: null, attempts: (r.attempts ?? 0) + 1 })
      .eq("id", r.id).eq("status", "failed"); // compare-and-set: don't clobber a concurrent manual retry
    if (!upErr) n++;
  }
  return n;
}

export type FlushResult = { sent: number; failed: number; queued: number; sentIds: string[]; failedIds: string[] };

/** Sends everything queued. Individual failures are recorded, never thrown. Returns counts + per-row outcomes. */
export async function flushOutbox(repo: HelpdeskRepo, mailer: Mailer | null): Promise<FlushResult> {
  await requeueFailedOutbox().catch(() => 0); // bounded auto-retry; no-op without Supabase/0057
  const queued = await repo.listEmails("queued");
  if (!mailer) return { sent: 0, failed: 0, queued: queued.length, sentIds: [], failedIds: [] };
  let sent = 0, failed = 0;
  const sentIds: string[] = [], failedIds: string[] = [];
  for (const e of queued) {
    try {
      const s = resolveSender(e.sender);
      await mailer.send({
        to: e.to, subject: e.subject, body: e.body, html: e.html,
        from: s ? { name: s.name, email: s.email } : null,
        replyTo: e.replyTo ?? s?.replyTo ?? null,
      });
      await repo.markEmail(e.id, "sent"); sent++; sentIds.push(e.id);
    }
    catch (err) { await repo.markEmail(e.id, "failed", err instanceof Error ? err.message : "error"); failed++; failedIds.push(e.id); }
  }
  return { sent, failed, queued: 0, sentIds, failedIds };
}
