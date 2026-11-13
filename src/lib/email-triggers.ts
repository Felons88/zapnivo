import type { SupabaseClient } from "@supabase/supabase-js";
import { renderEmail, renderEmailText } from "./email-templates";
import { flushOutbox, getMailer } from "./helpdesk/mailer";
import { getRepo } from "./helpdesk/repo";
import { fmt, PRICING_V1 } from "./pricing";
import { cancelRentalSms, queueJob, scheduleRentalSms } from "./notifications";
import { sendSms } from "./sms";
import { serviceClient } from "./supabase";
import { SITE, subUrl } from "./site";
import { signReceipt } from "./billing";

/** Rental lifecycle email triggers — queue into the helpdesk outbox (so delivery state is visible), then flush. */

type RentalRow = {
  id: string; reference: string; state: string;
  started_at: string | null; dispensed_at: string | null; returned_at: string | null; non_return_deadline: string | null;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: { receipt_email: string | null; amount_captured_cents: number | null; stripe_payment_intent_id: string | null; customer_phone: string | null; tax_cents?: number | null; discount_cents?: number | null }[];
};

export const stamp = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
export const year = () => String(new Date().getFullYear());
// Confirmed pricing: flat $6.99 per started hour, uncapped; $45 non-return fee after 24h.
const pricingSummary = () => `${fmt(PRICING_V1.firstHourCents)} first hour · ${fmt(PRICING_V1.additionalHourCents)} per started hour · ${fmt(PRICING_V1.nonReturnMaxCents)} non-return fee after ${PRICING_V1.nonReturnAfterHours}h`;

export type { RentalRow };

/** Fetches a rental with venue + payment context, scoped to a single row. */
export async function loadRental(where: { id?: string; stripeId?: string }): Promise<RentalRow | null> {
  const db = serviceClient();
  if (!db) return null;
  const sel = "id,reference,state,started_at,dispensed_at,returned_at,non_return_deadline,kiosks(station_id,venues(name,city)),payments(receipt_email,amount_captured_cents,stripe_payment_intent_id,tax_cents,discount_cents)";
  const q = where.id
    ? db.from("rentals").select(sel).eq("id", where.id)
    : db.from("rentals").select(sel + ",payments!inner(stripe_payment_intent_id)").eq("payments.stripe_payment_intent_id", where.stripeId!);
  const { data } = await q.limit(1).maybeSingle();
  return (data as unknown as RentalRow) ?? null;
}

/** Routing metadata recorded on the outbox row — resolves the department sender at flush time. */
export type EmailMeta = { sender?: string | null; template?: string | null; event?: string | null };

/** Outcome of a customer send attempt — distinguishes "queued" from "actually delivered". */
export type SendOutcome = {
  /** Row was written to email_outbox (may still be awaiting delivery). */
  queued: boolean;
  /** The provider accepted THIS message during this call. */
  sent: boolean;
  /** Why nothing was delivered this call: no repo, no provider configured, or the send failed. */
  reason: "no_repo" | "no_provider" | "send_failed" | null;
};

/**
 * Queues into the helpdesk outbox, then flushes. Returns a tri-state outcome so
 * callers can tell "queued for later" apart from "handed to the provider" —
 * conversation state must only claim an answer was sent when `sent` is true.
 */
export async function sendToCustomerOutcome(email: string, subject: string, body: string, html: string | null, ticketId = null as string | null, meta: EmailMeta = {}): Promise<SendOutcome> {
  const repo = await getRepo();
  if (!repo) return { queued: false, sent: false, reason: "no_repo" };
  const row = await repo.queueEmail({ ticketId, to: email, subject, body, html, sender: meta.sender ?? null, replyTo: null, template: meta.template ?? null, event: meta.event ?? null });
  const mailer = getMailer();
  if (!mailer) return { queued: true, sent: false, reason: "no_provider" };
  const res = await flushOutbox(repo, mailer);
  const sent = res.sentIds.includes(row.id);
  return { queued: true, sent, reason: sent ? null : "send_failed" };
}

/**
 * Back-compatible boolean wrapper: true when the message was accepted into the
 * outbox (queued OR sent). Use sendToCustomerOutcome when delivery state matters.
 */
export async function sendToCustomer(email: string, subject: string, body: string, html: string | null, ticketId = null as string | null, meta: EmailMeta = {}) {
  return (await sendToCustomerOutcome(email, subject, body, html, ticketId, meta)).queued;
}

export type StaffAlert = {
  subject: string;
  body: string;
  sender?: string | null;
  template?: string | null;
  event?: string | null;
};

/**
 * Queues an email to every admin/staff profile — the staff-notification path
 * used by public forms and the receptionist. Best-effort: returns the number
 * of messages queued (0 when no backend/staff exist) and never throws.
 * `db` defaults to the service client; pass an existing client to reuse one.
 */
export async function alertStaff(alert: StaffAlert, db: SupabaseClient | null = serviceClient()): Promise<number> {
  try {
    if (!db) return 0;
    const { data } = await db.from("profiles").select("email").in("role", ["admin", "staff"]).limit(50);
    const emails = [...new Set(
      ((data ?? []) as { email: string | null }[])
        .map((r) => r.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    )];
    let queued = 0;
    for (const to of emails) {
      const res = await sendToCustomerOutcome(to, alert.subject, alert.body, null, null, {
        sender: alert.sender ?? "admin",
        template: alert.template ?? null,
        event: alert.event ?? null,
      });
      if (res.queued) queued++;
    }
    return queued;
  } catch {
    return 0;
  }
}

export const emailFor = (r: RentalRow) => r.payments?.[0]?.receipt_email ?? null;
export const rentalUrl = () => subUrl("support", "/#find-rental");
const phoneFor = (r: RentalRow) => r.payments?.[0]?.customer_phone ?? null;
export const smsFor = async (r: RentalRow, body: string) => { const phone = phoneFor(r); if (!phone) return; const db = serviceClient(); if (db) await sendSms(db, { to: phone, body, rentalId: r.id }); };

export async function triggerRentalStarted(rentalId: string) {
  const r = await loadRental({ id: rentalId });
  const to = r && emailFor(r);
  if (!r) return false;
  const db0 = serviceClient();
  if (db0) await scheduleRentalSms(db0, rentalId, new Date(r.dispensed_at ?? r.started_at ?? Date.now()));
  if (!to) return false;
  return sendToCustomer(to, "Your Zapnivo rental is active",
    `Your rental ${r.reference} is active${r.kiosks?.venues ? ` from ${r.kiosks.venues.name}` : ""}. Keep the power bank with you — return it to any eligible station when you're done.`,
    renderEmail("rental_started", {
      rental_id: r.reference, rental_url: rentalUrl(), start_time: stamp(r.started_at),
      venue_name: r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "Zapnivo station",
      pricing_summary: pricingSummary(), year: year(),
    }), null, { sender: "rentals", template: "rental_started", event: "rental.started" });
}

export async function triggerRentalReturned(rentalId: string) {
  const r = await loadRental({ id: rentalId });
  const to = r && emailFor(r);
  if (!r) return false;
  const db0 = serviceClient();
  if (db0) await cancelRentalSms(db0, rentalId);
  if (!to) return false;
  return sendToCustomer(to, "Your Zapnivo return is confirmed",
    `Rental ${r.reference} is returned. Thanks for using Zapnivo.`,
    renderEmail("rental_returned", {
      rental_id: r.reference, rental_total: fmt(r.payments?.[0]?.amount_captured_cents ?? 0),
      rental_url: rentalUrl(), return_time: stamp(r.returned_at),
      return_venue: r.kiosks?.venues?.name ?? "Zapnivo station", year: year(),
    }), null, { sender: "rentals", template: "rental_returned", event: "rental.returned" });
}

export async function triggerRentalReminder(rental: RentalRow) {
  const to = emailFor(rental);
  if (!to) return false;
  return sendToCustomer(to, "Reminder: your Zapnivo rental is active",
    `Rental ${rental.reference} is still active — return by ${stamp(rental.non_return_deadline)} to avoid the non-return charge.`,
    renderEmail("rental_reminder", {
      rental_id: rental.reference, rental_url: rentalUrl(), rental_status: "active",
      start_time: stamp(rental.started_at), pricing_summary: pricingSummary(), year: year(),
    }), null, { sender: "rentals", template: "rental_reminder", event: "rental.reminder" });
}

export async function triggerNonreturnNotice(rental: RentalRow) {
  const to = emailFor(rental);
  if (!to) return false;
  return sendToCustomer(to, "Zapnivo rental not returned",
    `Rental ${rental.reference} was not returned by the deadline. Please return the power bank or contact support.`,
    renderEmail("nonreturn_notice", {
      rental_id: rental.reference, rental_status: "not returned", rental_url: rentalUrl(),
      return_deadline: stamp(rental.non_return_deadline), start_time: stamp(rental.started_at), year: year(),
    }), null, { sender: "rentals", template: "nonreturn_notice", event: "rental.nonreturn_notice" });
}

export async function triggerPaymentReceipt(stripePaymentIntentId: string) {
  const r = await loadRental({ stripeId: stripePaymentIntentId });
  const to = r && emailFor(r);
  if (!r || !to) return false;
  const p = r.payments[0];
  const paid = fmt(p.amount_captured_cents ?? 0);
  return sendToCustomer(to, "Your Zapnivo payment receipt",
    `Receipt for rental ${r.reference}: ${paid} captured on ${stamp(null)}.`,
    renderEmail("payment_receipt", {
      receipt_id: r.reference, receipt_url: receiptUrl(r.reference, to) ?? rentalUrl(), rental_id: r.reference,
      subtotal: fmt((p.amount_captured_cents ?? 0) + (p.discount_cents ?? 0) - (p.tax_cents ?? 0)),
      tax: (p.tax_cents ?? 0) > 0 ? fmt(p.tax_cents ?? 0) : "Not applied", total_paid: paid, year: year(),
    }), null, { sender: "billing", template: "payment_receipt", event: "payment.receipt" });
}

/** Signed link to the PDF receipt endpoint (null when no signing secret is available). */
function receiptUrl(reference: string, email: string) {
  const t = signReceipt(reference, email);
  return t ? `${SITE.url.replace(/\/$/, "")}/api/receipts/${encodeURIComponent(reference)}?t=${encodeURIComponent(t)}` : null;
}

/** Plain-text only: there is no designed template for failed payments. */
export async function triggerPaymentFailed(rentalId: string) {
  const r = await loadRental({ id: rentalId });
  // Queue the SMS confirmation too (transactional kind — sends even without sms_consent,
  // deduped per rental, picked up by the cron sweep). Best-effort: never blocks the email.
  const db0 = serviceClient();
  if (db0) await queueJob(db0, { kind: "payment_failed", rentalId }).catch(() => false);
  const to = r && emailFor(r);
  if (!r || !to) return false;
  return sendToCustomer(to, "Your Zapnivo payment didn't go through",
    `We couldn't authorize the payment for rental ${r.reference}, so no power bank was released and you have not been charged. You can try again from the station's QR code, or contact support at support.zapnivo.com with reference ${r.reference}.`,
    null, null, { sender: "billing", template: null, event: "rental.payment_failed" });
}

/** Branded account-invitation email (replaces the default Supabase invite template). */
export async function sendAccountInvite(to: string, opts: { name?: string | null; roleLabel: string; orgName?: string | null; inviteUrl: string }) {
  const name = (opts.name ?? "").trim() || "there";
  const orgPhrase = opts.orgName ? ` with ${opts.orgName}` : "";
  return sendToCustomer(to, "You're invited to Zapnivo",
    renderEmailText("account_invite", {
      name, role_label: opts.roleLabel, org_phrase: orgPhrase,
      invite_url: opts.inviteUrl, expires_note: "This invitation link is single-use — ask an administrator to resend it if it expires.", year: year(),
    }),
    renderEmail("account_invite", {
      name, role_label: opts.roleLabel, org_phrase: orgPhrase,
      invite_url: opts.inviteUrl, expires_note: "This invitation link is single-use — ask an administrator to resend it if it expires.", year: year(),
    }), null, { sender: "admin", template: "account_invite", event: "account.invite" });
}

/** Daily cron sweep: reminders inside the deadline window, notices for overdue rentals. */
export async function runRentalSweep(now = new Date()) {
  const db = serviceClient();
  if (!db) return { reminders: 0, notices: 0 };
  const soon = new Date(now.getTime() + 26 * 3600_000).toISOString();
  const sel = "id,reference,state,started_at,dispensed_at,returned_at,non_return_deadline,kiosks(station_id,venues(name,city)),payments(receipt_email,amount_captured_cents,stripe_payment_intent_id,customer_phone)";
  const [due, overdue] = await Promise.all([
    db.from("rentals").select(sel).eq("state", "active").not("non_return_deadline", "is", null).lte("non_return_deadline", soon).gt("non_return_deadline", now.toISOString()),
    db.from("rentals").select(sel).eq("state", "active").not("non_return_deadline", "is", null).lte("non_return_deadline", now.toISOString()),
  ]);
  let reminders = 0, notices = 0;
  for (const r of (due.data ?? []) as unknown as RentalRow[]) { if (await triggerRentalReminder(r)) reminders++; }
  for (const r of (overdue.data ?? []) as unknown as RentalRow[]) {
    await db.from("rentals").update({ state: "unreturned" }).eq("id", r.id);
    if (await triggerNonreturnNotice(r)) notices++;
  }
  return { reminders, notices };
}
