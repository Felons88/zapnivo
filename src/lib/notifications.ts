import type { SupabaseClient } from "@supabase/supabase-js";
import { fmt, rentalChargeCents, PRICING_V1 } from "./pricing";
import { sendSms } from "./sms";

/**
 * Durable SMS schedule engine. Jobs live in notification_jobs (unique per rental+kind),
 * claimed atomically by flipping queued→sending, retried with exponential backoff,
 * cancelled when the rental returns/closes. Killed globally by system_config.sms_enabled=false.
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

export const DEFAULT_TEMPLATES: Record<string, string> = {
  activation: "Zapnivo: rental {ref} is active — {rate}/hr, return by {deadline}. Unreturned chargers incur a separate {fee} fee.",
  reminder_1h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_3h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_6h: "Zapnivo: {ref} still active, {charges} accrued. Return by {deadline}.",
  reminder_12h: "Zapnivo: {ref} — 12h left to return ({deadline}). Charges now {charges}.",
  warning_20h: "Zapnivo: {ref} — 4h left before the {fee} non-return fee applies ({deadline}).",
  warning_23h: "Zapnivo: {ref} — FINAL warning, 1h left ({deadline}). Return to any station.",
  deadline_24h: "Zapnivo: {ref} deadline passed. Return now to avoid the {fee} non-return fee.",
};

const stamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "—";

/** Interpolates {var} placeholders; escapes braces in values so templates can't be poisoned. */
export function interpolate(template: string, vars: Record<string, string>) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v.replace(/[{}]/g, ""));
  return out;
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

/** Cancels everything still queued for a rental (call on verified return/close). */
export async function cancelRentalSms(db: SupabaseClient, rentalId: string) {
  await db.from("notification_jobs").update({ status: "cancelled" }).eq("rental_id", rentalId).in("status", ["queued", "sending"]);
}

async function templateFor(db: SupabaseClient, kind: string) {
  const { data } = await db.from("sms_templates").select("body").eq("kind", kind).maybeSingle();
  return data?.body ?? DEFAULT_TEMPLATES[kind] ?? null;
}

/**
 * Processes due jobs. Atomic claim: flip queued→sending (PostgREST update is atomic per row —
 * a second sweeper sees status='sending' and skips). Retries with 2^attempts-minute backoff.
 * Re-verifies the rental is still active & unreturned before warning/deadline messages.
 */
export async function runSmsSweep(db: SupabaseClient, now = new Date()) {
  if (!(await flag(db, "sms_enabled"))) return { sent: 0, skipped: "sms_disabled" };
  const { data: due } = await db.from("notification_jobs")
    .select("id,rental_id,kind,attempts")
    .eq("status", "queued").lte("due_at", now.toISOString()).limit(50);
  let sent = 0, failed = 0;
  for (const job of (due ?? []) as { id: string; rental_id: string; kind: string; attempts: number }[]) {
    const { data: claimed } = await db.from("notification_jobs")
      .update({ status: "sending", attempts: job.attempts + 1 })
      .eq("id", job.id).eq("status", "queued").select("id").maybeSingle();
    if (!claimed) continue; // another sweeper took it

    const { data: r } = await db.from("rentals")
      .select("id,reference,state,started_at,dispensed_at,non_return_deadline,returned_at,payments(customer_phone)")
      .eq("id", job.rental_id).maybeSingle();
    const rental = r as { id: string; reference: string; state: string; started_at: string | null; dispensed_at: string | null; non_return_deadline: string | null; returned_at: string | null; payments: { customer_phone: string | null }[] | { customer_phone: string | null } | null } | null;
    const phone = rental?.payments ? (Array.isArray(rental.payments) ? rental.payments[0]?.customer_phone : rental.payments.customer_phone) : null;
    const terminal = !rental || rental.returned_at || ["returned", "closed", "cancelled", "disputed"].includes(rental.state);

    // Never send reminders/warnings for returned or closed rentals.
    if (terminal) { await db.from("notification_jobs").update({ status: "cancelled" }).eq("id", job.id); continue; }

    // Deadline/warning jobs re-verify the rental is actually still out past the mark.
    const elapsedMin = rental ? (now.getTime() - new Date(rental.dispensed_at ?? rental.started_at ?? now.toISOString()).getTime()) / 60_000 : 0;
    const needMin = SMS_SCHEDULE.find((s) => s.kind === job.kind)?.minutesAfterActivation ?? 0;
    if (elapsedMin < needMin - 5) { await db.from("notification_jobs").update({ status: "queued" }).eq("id", job.id); continue; }

    const charges = rental && rental.started_at ? (rentalChargeCents((now.getTime() - new Date(rental.started_at).getTime()) / 60_000) ?? null) : null;
    const vars = {
      ref: rental?.reference ?? "", rate: fmt(699), fee: fmt(4500),
      deadline: stamp(rental?.non_return_deadline ?? null),
      charges: charges != null ? fmt(charges) : "—",
    };
    const tpl = await templateFor(db, job.kind);
    const body = tpl ? interpolate(tpl, vars) : null;
    const res = phone && body ? await sendSms(db, { to: phone, body, rentalId: job.rental_id }) : { sent: false as const };
    if (res.sent) {
      await db.from("notification_jobs").update({ status: "sent", sent_at: now.toISOString(), last_error: null }).eq("id", job.id);
      sent++;
    } else {
      const attempts = job.attempts + 1;
      const backoffMin = Math.min(120, 2 ** attempts); // exponential, capped at 2h
      await db.from("notification_jobs").update({
        status: attempts >= 5 ? "failed" : "queued",
        last_error: phone ? "send_failed" : "no_phone",
        due_at: new Date(now.getTime() + backoffMin * 60_000).toISOString(),
      }).eq("id", job.id);
      failed++;
    }
  }
  return { sent, failed };
}
