import { resolveSender } from "../email/senders";
import type { HelpdeskRepo } from "./repo";

/**
 * Email delivery seam. Everything customer-visible is first written to the outbox (so nothing is lost
 * and the UI can show delivery state), then flushed through a Mailer. With no provider configured,
 * emails stay "queued"; the product never claims an email was sent when it wasn't.
 *
 * Provider: Resend (set RESEND_API_KEY + SUPPORT_FROM_EMAIL, a verified sender like "Zapnivo Support <support@yourdomain>").
 * Inbound replies-by-email would arrive via a provider webhook (future) and call addCustomerMessage.
 *
 * Sender identity: a message may carry `from` (department sender from ../email/senders.ts) and
 * `replyTo`. When absent, the provider default SUPPORT_FROM_EMAIL is used — unchanged legacy behavior.
 */
export interface Mailer {
  send(m: {
    to: string; subject: string; body: string; html?: string | null;
    from?: { name: string; email: string } | null;
    replyTo?: string | null;
  }): Promise<void>;
}

export const mailerConfigured = () => Boolean(
  (process.env.RESEND_API_KEY || process.env.BREVO_API_KEY) && process.env.SUPPORT_FROM_EMAIL,
);

/** "Name <email>" → { name, email }; bare address → { email }. */
const parseFrom = (raw: string) => {
  const match = raw.match(/^(.*)<([^>]+)>\s*$/);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { email: raw.trim() };
};

export class ResendMailer implements Mailer {
  async send(m: { to: string; subject: string; body: string; html?: string | null; from?: { name: string; email: string } | null; replyTo?: string | null }) {
    const from = m.from ? `${m.from.name} <${m.from.email}>` : process.env.SUPPORT_FROM_EMAIL;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.body, reply_to: m.replyTo ?? undefined, ...(m.html ? { html: m.html } : {}) }),
    });
    if (!res.ok) throw new Error(`resend_${res.status}`);
  }
}

/** Brevo (Sendinblue) transactional API — set BREVO_API_KEY + SUPPORT_FROM_EMAIL. */
export class BrevoMailer implements Mailer {
  async send(m: { to: string; subject: string; body: string; html?: string | null; from?: { name: string; email: string } | null; replyTo?: string | null }) {
    const sender = m.from ?? parseFrom(process.env.SUPPORT_FROM_EMAIL!);
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

/** Sends everything queued. Individual failures are recorded, never thrown. Returns counts. */
export async function flushOutbox(repo: HelpdeskRepo, mailer: Mailer | null) {
  const queued = await repo.listEmails("queued");
  if (!mailer) return { sent: 0, failed: 0, queued: queued.length };
  let sent = 0, failed = 0;
  for (const e of queued) {
    try {
      const s = resolveSender(e.sender);
      await mailer.send({
        to: e.to, subject: e.subject, body: e.body, html: e.html,
        from: s ? { name: s.name, email: s.email } : null,
        replyTo: e.replyTo ?? s?.replyTo ?? null,
      });
      await repo.markEmail(e.id, "sent"); sent++;
    }
    catch (err) { await repo.markEmail(e.id, "failed", err instanceof Error ? err.message : "error"); failed++; }
  }
  return { sent, failed, queued: 0 };
}
