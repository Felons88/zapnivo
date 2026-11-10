import { renderEmail } from "./email-templates";
import { flushOutbox, getMailer } from "./helpdesk/mailer";
import { getRepo } from "./helpdesk/repo";
import { fmt, PRICING_V1 } from "./pricing";
import { cancelRentalSms, scheduleRentalSms } from "./notifications";
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

const stamp = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const year = () => String(new Date().getFullYear());
const pricingSummary = () => `${fmt(PRICING_V1.firstHourCents)} first hour · ${fmt(PRICING_V1.additionalHourCents)}/hr after · ${fmt(PRICING_V1.first24hCapCents)}/day cap`;

/** Fetches a rental with venue + payment context, scoped to a single row. */
async function loadRental(where: { id?: string; stripeId?: string }): Promise<RentalRow | null> {
  const db = serviceClient();
  if (!db) return null;
  const sel = "id,reference,state,started_at,dispensed_at,returned_at,non_return_deadline,kiosks(station_id,venues(name,city)),payments(receipt_email,amount_captured_cents,stripe_payment_intent_id,tax_cents,discount_cents)";
  const q = where.id
    ? db.from("rentals").select(sel).eq("id", where.id)
    : db.from("rentals").select(sel + ",payments!inner(stripe_payment_intent_id)").eq("payments.stripe_payment_intent_id", where.stripeId!);
  const { data } = await q.limit(1).maybeSingle();
  return (data as unknown as RentalRow) ?? null;
}

async function sendToCustomer(email: string, subject: string, body: string, html: string | null, ticketId = null as string | null) {
  const repo = await getRepo();
  if (!repo) return false;
  await repo.queueEmail({ ticketId, to: email, subject, body, html });
  await flushOutbox(repo, getMailer());
  return true;
}

const emailFor = (r: RentalRow) => r.payments?.[0]?.receipt_email ?? null;
const phoneFor = (r: RentalRow) => r.payments?.[0]?.customer_phone ?? null;
const smsFor = async (r: RentalRow, body: string) => { const phone = phoneFor(r); if (!phone) return; const db = serviceClient(); if (db) await sendSms(db, { to: phone, body, rentalId: r.id }); };
const rentalUrl = () => subUrl("support", "/#find-rental");

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
    }));
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
    }));
}

export async function triggerRentalReminder(rental: RentalRow) {
  const to = emailFor(rental);
  if (!to) return false;
  return sendToCustomer(to, "Reminder: your Zapnivo rental is active",
    `Rental ${rental.reference} is still active — return by ${stamp(rental.non_return_deadline)} to avoid the non-return charge.`,
    renderEmail("rental_reminder", {
      rental_id: rental.reference, rental_url: rentalUrl(), rental_status: "active",
      start_time: stamp(rental.started_at), pricing_summary: pricingSummary(), year: year(),
    }));
}

export async function triggerNonreturnNotice(rental: RentalRow) {
  const to = emailFor(rental);
  if (!to) return false;
  return sendToCustomer(to, "Zapnivo rental not returned",
    `Rental ${rental.reference} was not returned by the deadline. Please return the power bank or contact support.`,
    renderEmail("nonreturn_notice", {
      rental_id: rental.reference, rental_status: "not returned", rental_url: rentalUrl(),
      return_deadline: stamp(rental.non_return_deadline), start_time: stamp(rental.started_at), year: year(),
    }));
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
    }));
}

/** Signed link to the PDF receipt endpoint (null when no signing secret is available). */
function receiptUrl(reference: string, email: string) {
  const t = signReceipt(reference, email);
  return t ? `${SITE.url.replace(/\/$/, "")}/api/receipts/${encodeURIComponent(reference)}?t=${encodeURIComponent(t)}` : null;
}

/** Plain-text only: there is no designed template for failed payments. */
export async function triggerPaymentFailed(rentalId: string) {
  const r = await loadRental({ id: rentalId });
  const to = r && emailFor(r);
  if (!r || !to) return false;
  return sendToCustomer(to, "Your Zapnivo payment didn't go through",
    `We couldn't authorize the payment for rental ${r.reference}, so no power bank was released and you have not been charged. You can try again from the station's QR code, or contact support at support.zapnivo.com with reference ${r.reference}.`,
    null);
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
