import type { SupabaseClient } from "@supabase/supabase-js";
import { fmt, rentalChargeCents, PRICING_V1 } from "./pricing";
import { isOptedOut, isTransactionalKind, normalizePhone, sendSms, type SmsSendResult } from "./sms";
import { serviceClient } from "./supabase";
import { SITE, subUrl } from "./site";
import { signAccess } from "./helpdesk/access";

/**
 * Durable SMS schedule engine. Jobs live in notification_jobs (unique per rental+kind,
 * or per ticket+kind for ticket confirmations), claimed atomically by flipping
 * queued→sending, retried with exponential backoff, cancelled when the rental
 * returns/closes. Killed globally by system_config.sms_enabled=false.
 *
 * Consent model: the scheduled nudges (SMS_SCHEDULE) require rentals.sms_consent AND
 * no sms_opt_outs row. Event confirmations (TRANSACTIONAL_KINDS in sms.ts — fee charged,
 * payment failed, return failed, ticket received) are receipts of things that already
 * happened: they send regardless of the marketing opt-in, per the rental-terms consent
 * wording, but are still logged and deduped like every other job.
 */

export const SMS_SCHEDULE = [
  { kind: "activation", minutesAfterActivation: 0 },
  { kind: "reminder_1h", minutesAfterActivation: 60 },
  { kind: "reminder_3h", minutesAfterActivation: 180 },
  { kind: "reminder_6h", minutesAfterActivation: 360 },
  { kind: "reminder_12h", minutesAfterActivation: 720 },
  { kind: "warning_20h", minutesAfterActivation: 1200 },
  { kind: "warning_23h", minutesAfterActivation: 1380 },
  { kind: "deadline_24h", minutesAfterActivation: 1440 },
] as const;

/** Every job kind the engine knows — must match the notification_jobs kind CHECK (migration 0019). */
export const SMS_JOB_KINDS = [
  "activation", "reminder_1h", "reminder_3h", "reminder_6h", "reminder_12h",
  "warning_20h", "warning_23h", "deadline_24h",
  "return_failed", "non_return_fee_charged", "payment_failed", "ticket_received",
] as const;
export type SmsJobKind = (typeof SMS_JOB_KINDS)[number];

export const DEFAULT_TEMPLATES: Record<string, string> = {
  activation: "Zapnivo: rental {ref} is active — {rate}/hr, return by {deadline}. Unreturned chargers incur a separate {fee} fee.",
  reminder_1h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_3h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_6h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_12h: "Zapnivo: {ref} — 12h left to return ({deadline}). Charges now {charges}.",
  warning_20h: "Zapnivo: {ref} — 4h left before the {fee} non-return fee applies ({deadline}).",
  warning_23h: "Zapnivo: {ref} — FINAL warning, 1h left ({deadline}). Return to any station.",
  deadline_24h: "Zapnivo: {ref} deadline passed. Return now to avoid the {fee} non-return fee.",
  return_failed: "Zapnivo: we couldn't confirm the return of {ref}. Please try returning at any Zapnivo station, or reply here for help.",
  non_return_fee_charged: "Zapnivo: the {fee} non-return fee for {ref} has been charged to your card on file.",
  payment_failed: "Zapnivo: we couldn't process payment for {ref}, so no charger was released and you haven't been charged. Resolve it here: {url}",
  ticket_received: "Zapnivo: we received your support request {ticket}. Track replies here: {url}",
};

/** Sample values for the admin live preview — real formatting helpers, never sent. */
export const SMS_SAMPLE_VARS: Record<string, string> = {
  ref: "ZR-ABC123", rate: fmt(PRICING_V1.firstHourCents), fee: fmt(PRICING_V1.nonReturnMaxCents),
  deadline: "Nov 12, 3:00 PM UTC", charges: fmt(PRICING_V1.firstHourCents * 3),
  url: `${SITE.url.replace(/\/$/, "")}/account`, ticket: "Z-1042", name: "there",
};

const stamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "—";

/** Interpolates {var} placeholders; escapes braces in values so templates can't be poisoned. */
export function interpolate(template: string, vars: Record<string, string>) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v.replace(/[{}]/g, ""));
  return out;
}

/** Renders a template with sample data — used by the admin live preview and tests. */
export function previewTemplate(template: string, vars: Record<string, string> = SMS_SAMPLE_VARS) {
  return interpolate(template, vars);
}

export async function flag(db: SupabaseClient, key: string): Promise<boolean> {
  const { data } = await db.from("system_config").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? "true") !== "false";
}

/** Queues the confirmed schedule for a rental (idempotent — unique key per kind). */
export async function scheduleRentalSms(db: SupabaseClient, rentalId: string, activatedAt: Date) {
  const rows = SMS_SCHEDULE.map((s) => ({
    rental_id: rentalId, kind: s.kind, status: "queued",
    due_at: new Date(activatedAt.getTime() + s.minutesAfterActivation * 60_000).toISOString(),
  }));
  await db.from("notification_jobs").upsert(rows, { onConflict: "rental_id,kind", ignoreDuplicates: true });
}

/**
 * Queues one event-driven job. Dedupe: rental jobs on (rental_id, kind); ticket jobs on
 * (ticket_id, kind). dueAt defaults to now — the cron sweep picks it up.
 */
export async function queueJob(db: SupabaseClient, job: { kind: SmsJobKind; rentalId?: string | null; ticketId?: string | null; dueAt?: Date }) {
  const row = {
    rental_id: job.rentalId ?? null, ticket_id: job.ticketId ?? null, kind: job.kind,
    status: "queued", due_at: (job.dueAt ?? new Date()).toISOString(),
  };
  const onConflict = job.ticketId && !job.rentalId ? "ticket_id,kind" : "rental_id,kind";
  await db.from("notification_jobs").upsert(row, { onConflict, ignoreDuplicates: true });
  return true;
}

/** Cancels everything still queued for a rental (call on verified return/close). */
export async function cancelRentalSms(db: SupabaseClient, rentalId: string) {
  await db.from("notification_jobs").update({ status: "cancelled" }).eq("rental_id", rentalId).in("status", ["queued", "sending"]);
}

/* ── Event triggers (called by billing/ops code — never auto-approved, just queued) ── */

/** Non-return fee captured — call after the fee PaymentIntent succeeds (chargeNonReturn in api/rentals/[id]). */
export async function notifyFeeCharged(rentalId: string, db: SupabaseClient | null = serviceClient()) {
  if (!db) return false;
  return queueJob(db, { kind: "non_return_fee_charged", rentalId });
}

/** Return attempt failed/rejected at the station — call wherever that is recorded (no such event exists yet; wire when added). */
export async function notifyReturnFailed(rentalId: string, db: SupabaseClient | null = serviceClient()) {
  if (!db) return false;
  return queueJob(db, { kind: "return_failed", rentalId });
}

/** Support ticket created — call from helpdesk createTicket / POST /api/support/tickets (service.ts is ops-owned). */
export async function notifyTicketReceived(ticketId: string, db: SupabaseClient | null = serviceClient()) {
  if (!db) return false;
  return queueJob(db, { kind: "ticket_received", ticketId });
}

async function templateFor(db: SupabaseClient, kind: string) {
  const { data } = await db.from("sms_templates").select("body").eq("kind", kind).maybeSingle();
  return data?.body ?? DEFAULT_TEMPLATES[kind] ?? null;
}

type JobRow = { id: string; rental_id: string | null; ticket_id: string | null; kind: string; attempts: number };

async function markSent(db: SupabaseClient, job: JobRow, now: Date) {
  await db.from("notification_jobs").update({ status: "sent", sent_at: now.toISOString(), last_error: null }).eq("id", job.id);
}
async function markRetry(db: SupabaseClient, job: JobRow, now: Date, error: string) {
  const attempts = job.attempts + 1;
  const backoffMin = Math.min(120, 2 ** attempts); // exponential, capped at 2h
  await db.from("notification_jobs").update({
    status: attempts >= 5 ? "failed" : "queued",
    last_error: error,
    due_at: new Date(now.getTime() + backoffMin * 60_000).toISOString(),
  }).eq("id", job.id);
  return attempts >= 5 ? "failed" as const : "retried" as const;
}
async function markCancelled(db: SupabaseClient, job: JobRow, error: string) {
  await db.from("notification_jobs").update({ status: "cancelled", last_error: error }).eq("id", job.id);
}

/** Support-ticket confirmation job: phone comes from the ticket, link is the signed thread URL. */
async function sweepTicketJob(db: SupabaseClient, job: JobRow, now: Date): Promise<"sent" | "failed" | "cancelled" | "retried"> {
  const { data: t } = await db.from("support_tickets")
    .select("id,ticket_number,name,email,phone,state")
    .eq("id", job.ticket_id).maybeSingle();
  const ticket = t as { id: string; ticket_number: string; name: string | null; email: string; phone: string | null; state: string } | null;
  if (!ticket) { await markCancelled(db, job, "ticket_missing"); return "cancelled"; }
  if (["resolved", "closed"].includes(ticket.state)) { await markCancelled(db, job, "ticket_closed"); return "cancelled"; }
  const phone = normalizePhone(ticket.phone);
  if (!phone) { await markRetry(db, job, now, "no_phone"); return "failed"; }

  const tok = signAccess(ticket.ticket_number, ticket.email);
  const vars = {
    ticket: ticket.ticket_number, name: ticket.name ?? "there",
    url: tok ? subUrl("support", `/ticket/${ticket.ticket_number}?t=${encodeURIComponent(tok)}`) : subUrl("support", "/"),
  };
  const tpl = await templateFor(db, job.kind);
  const body = tpl ? interpolate(tpl, vars) : null;
  const res: SmsSendResult = body ? await sendSms(db, { to: phone, body, ticketId: ticket.id, kind: job.kind }) : { sent: false };
  if (res.sent) { await markSent(db, job, now); return "sent"; }
  return markRetry(db, job, now, res.reason === "opted_out" ? "opted_out" : phone ? "send_failed" : "no_phone");
}

/**
 * Processes due jobs. Atomic claim: flip queued→sending (PostgREST update is atomic per row —
 * a second sweeper sees status='sending' and skips). Retries with 2^attempts-minute backoff.
 * Scheduled kinds re-verify the rental is still active & unreturned; event kinds (transactional)
 * skip the consent/opt-out gates but still dedupe and retry.
 */
export async function runSmsSweep(db: SupabaseClient, now = new Date()) {
  if (!(await flag(db, "sms_enabled"))) return { sent: 0, skipped: "sms_disabled" };
  const { data: due } = await db.from("notification_jobs")
    .select("id,rental_id,ticket_id,kind,attempts")
    .eq("status", "queued").lte("due_at", now.toISOString()).limit(50);
  let sent = 0, failed = 0;
  for (const job of (due ?? []) as JobRow[]) {
    const { data: claimed } = await db.from("notification_jobs")
      .update({ status: "sending", attempts: job.attempts + 1 })
      .eq("id", job.id).eq("status", "queued").select("id").maybeSingle();
    if (!claimed) continue; // another sweeper took it

    // Ticket-scoped jobs (ticket_received) have no rental.
    if (!job.rental_id) {
      const r = await sweepTicketJob(db, job, now);
      if (r === "sent") sent++; else if (r === "failed") failed++;
      continue;
    }

    const { data: r } = await db.from("rentals")
      .select("id,reference,state,started_at,dispensed_at,non_return_deadline,returned_at,sms_consent,payments(customer_phone,amount_captured_cents)")
      .eq("id", job.rental_id).maybeSingle();
    const rental = r as { id: string; reference: string; state: string; started_at: string | null; dispensed_at: string | null; non_return_deadline: string | null; returned_at: string | null; sms_consent: boolean; payments: { customer_phone: string | null; amount_captured_cents: number | null }[] | { customer_phone: string | null; amount_captured_cents: number | null } | null } | null;
    const pay = rental?.payments ? (Array.isArray(rental.payments) ? rental.payments[0] : rental.payments) : null;
    const phone = pay?.customer_phone ?? null;
    const terminal = !rental || rental.returned_at || ["returned", "closed", "cancelled", "disputed"].includes(rental.state);
    const transactional = isTransactionalKind(job.kind);

    // Scheduled nudges die with the rental; event confirmations still fire (e.g. payment_failed
    // arrives after the rental is cancelled, non_return_fee_charged after charged_off).
    if (terminal && !transactional) { await markCancelled(db, job, "rental_closed"); continue; }
    // A return_failed notice is only truthful while the return is actually unconfirmed.
    if (job.kind === "return_failed" && (!rental || rental.returned_at || rental.state === "returned" || rental.state === "closed")) { await markCancelled(db, job, "return_confirmed"); continue; }
    // Consent gate: scheduled nudges need checkout sms_consent; transactional confirmations don't.
    if (!transactional && rental && !rental.sms_consent) { await markCancelled(db, job, "no_sms_consent"); continue; }
    // STOP opt-out suppresses nudges; transactional confirmations still send per consent wording.
    if (!transactional && (await isOptedOut(db, phone))) { await markCancelled(db, job, "opted_out"); continue; }
    if (!rental) { await markCancelled(db, job, "rental_missing"); continue; }

    // Deadline/warning jobs re-verify the rental is actually still out past the mark.
    const elapsedMin = (now.getTime() - new Date(rental.dispensed_at ?? rental.started_at ?? now.toISOString()).getTime()) / 60_000;
    const needMin = SMS_SCHEDULE.find((s) => s.kind === job.kind)?.minutesAfterActivation ?? 0;
    if (elapsedMin < needMin - 5) { await db.from("notification_jobs").update({ status: "queued" }).eq("id", job.id); continue; }

    const charges = rental.started_at ? (rentalChargeCents((now.getTime() - new Date(rental.started_at).getTime()) / 60_000) ?? null) : null;
    // Fee amount comes from the captured payment when known; otherwise the pricing constant.
    const feeCents = job.kind === "non_return_fee_charged" && pay?.amount_captured_cents && pay.amount_captured_cents > 0
      ? pay.amount_captured_cents : PRICING_V1.nonReturnMaxCents;
    const vars = {
      ref: rental.reference, rate: fmt(PRICING_V1.firstHourCents), fee: fmt(feeCents),
      deadline: stamp(rental.non_return_deadline),
      charges: charges != null ? fmt(charges) : "—",
      url: `${SITE.url.replace(/\/$/, "")}/account`, ticket: "", name: "",
    };
    const tpl = await templateFor(db, job.kind);
    const body = tpl ? interpolate(tpl, vars) : null;
    const res: SmsSendResult = phone && body ? await sendSms(db, { to: phone, body, rentalId: job.rental_id, kind: job.kind }) : { sent: false };
    if (res.sent) {
      await markSent(db, job, now);
      sent++;
    } else {
      const err = !phone ? "no_phone" : res.errorCode ? `send_failed:${res.errorCode}` : "send_failed";
      const outcome = await markRetry(db, job, now, err);
      if (outcome === "failed") failed++;
    }
  }
  return { sent, failed };
}
