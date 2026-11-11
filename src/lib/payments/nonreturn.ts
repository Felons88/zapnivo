import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "../audit";
import { createOffSessionPaymentIntent, retrievePaymentIntent, stripeChargeId } from "../stripe";
import { sendSms } from "../sms";
import { appendLedger, markLedger } from "./ledger";
import { newTraceId, recordLog, recordSpan } from "../observability";

/**
 * Non-return fee as a SEPARATE off-session PaymentIntent against the card saved at checkout
 * (setup_future_usage). Never runs without an admin confirmation upstream, never auto-retries,
 * and never charges twice: a pending/succeeded billing_ledger row blocks new attempts, and the
 * Stripe idempotency key makes a replayed call return the same PaymentIntent.
 *
 * The original manual-capture hold is NOT touched here — the caller releases it after success
 * (post-24h rental pricing is unresolved, so nothing is ever auto-captured).
 */

export const NON_RETURN_FEE_KIND = "non_return_fee";

export type NonReturnFeeResult =
  | { status: "charged"; detail: string; cents: number; paymentIntentId: string }
  | { status: "failed"; detail: string; paymentIntentId?: string }
  | { status: "skipped"; detail: string }
  | { status: "error"; detail: string };

export async function chargeNonReturnFee(
  db: SupabaseClient,
  args: { rentalId: string; reference: string | null; holdPaymentIntentId: string; feeCents: number; actor: string },
): Promise<NonReturnFeeResult> {
  const traceId = newTraceId();
  const start = performance.now();
  const span = (status: string, extra?: Record<string, unknown>) =>
    recordSpan({ traceId, name: "payments.non_return_fee", service: "payments", kind: "internal", startMs: start, durationMs: performance.now() - start, status, attrs: { rentalId: args.rentalId, feeCents: args.feeCents, ...extra } });
  const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
    recordLog(level, message, { service: "payments", route: "payments/nonreturn", traceId, attrs });
  const done = <T extends NonReturnFeeResult>(r: T): T => { span(r.status === "error" ? "error" : r.status === "failed" ? "error" : "ok", { outcome: r.status }); return r; };

  if (!Number.isInteger(args.feeCents) || args.feeCents <= 0) { log("error", "nonreturn_fee_invalid", { reason: "bad_amount" }); return done({ status: "error", detail: "Invalid fee amount." }); }

  // Double-charge guard: an open or succeeded ledger row means the fee is paid or in flight.
  const { data: open } = await db.from("billing_ledger").select("id")
    .eq("rental_id", args.rentalId).eq("kind", NON_RETURN_FEE_KIND).in("status", ["pending", "succeeded"]).limit(1).maybeSingle();
  if (open) { log("info", "nonreturn_fee_skipped", { reason: "already_open", rentalId: args.rentalId }); return done({ status: "skipped", detail: "The non-return fee is already charged or in progress for this rental." }); }

  // Recover the saved payment method from the original checkout PaymentIntent.
  const hold = await retrievePaymentIntent(args.holdPaymentIntentId);
  if (!hold.ok) { log("error", "nonreturn_fee_failed", { reason: "hold_read_failed", code: hold.code }); return done({ status: "error", detail: `Couldn't read the original payment (${hold.code}).` }); }
  const paymentMethodId = hold.data.payment_method;
  if (!paymentMethodId) { log("error", "nonreturn_fee_failed", { reason: "no_saved_payment_method" }); return done({ status: "error", detail: "The original checkout has no saved payment method to charge." }); }

  // Attempt number drives the idempotency key: attempt 1 is exactly `nonreturn:{rental_id}`;
  // a deliberate admin retry after a failure gets a suffixed key so Stripe doesn't replay the old failure.
  const { count } = await db.from("billing_ledger").select("id", { count: "exact", head: true })
    .eq("rental_id", args.rentalId).eq("kind", NON_RETURN_FEE_KIND);
  const attempt = (count ?? 0) + 1;
  const idem = attempt === 1 ? `nonreturn:${args.rentalId}` : `nonreturn:${args.rentalId}:${attempt}`;

  const pending = await appendLedger(db, {
    rentalId: args.rentalId, kind: NON_RETURN_FEE_KIND, amountCents: args.feeCents, status: "pending",
    idempotencyKey: idem, metadata: { attempt, reference: args.reference, hold_payment_intent_id: args.holdPaymentIntentId },
  });
  if (!pending.ok) { log("info", "nonreturn_fee_skipped", { reason: "ledger_duplicate", code: pending.code }); return done({ status: "skipped", detail: "The non-return fee was already recorded for this rental." }); }

  const created = await createOffSessionPaymentIntent({
    amountCents: args.feeCents, paymentMethodId, customerId: hold.data.customer ?? null,
    rentalId: args.rentalId, kind: NON_RETURN_FEE_KIND,
    description: `Zapnivo non-return fee${args.reference ? ` — rental ${args.reference}` : ""}`,
    idempotencyKey: idem,
  });

  const fail = async (detail: string, piId?: string): Promise<NonReturnFeeResult> => {
    await markLedger(db, idem, { status: "failed", stripePaymentIntentId: piId ?? null });
    await db.from("rentals").update({ non_return_fee_status: "failed" }).eq("id", args.rentalId);
    await auditLog(args.actor, "non_return_fee_failed", "rental", args.rentalId, { attempt, detail });
    await notifyFeeFailed(db, args.rentalId, args.reference, args.feeCents);
    log("warning", "nonreturn_fee_charge_failed", { attempt, paymentIntentId: piId ?? null });
    return done({ status: "failed", detail, paymentIntentId: piId });
  };

  if (!created.ok) return fail(`Fee charge failed (${created.code}).`, undefined);

  const pi = created.data;
  const succeeded = pi.status === "succeeded";
  await markLedger(db, idem, {
    status: succeeded ? "succeeded" : "failed",
    stripePaymentIntentId: pi.id, stripeChargeId: stripeChargeId(pi),
  });
  if (!succeeded) {
    await db.from("rentals").update({ non_return_fee_status: "failed" }).eq("id", args.rentalId);
    await auditLog(args.actor, "non_return_fee_failed", "rental", args.rentalId, { attempt, pi_status: pi.status, payment_intent: pi.id });
    await notifyFeeFailed(db, args.rentalId, args.reference, args.feeCents);
    log("warning", "nonreturn_fee_charge_failed", { attempt, piStatus: pi.status, paymentIntentId: pi.id });
    return done({ status: "failed", detail: `Fee charge did not complete (${pi.status}).`, paymentIntentId: pi.id });
  }

  await db.from("rentals").update({ non_return_fee_status: "charged" }).eq("id", args.rentalId);
  await auditLog(args.actor, "non_return_fee_charged", "rental", args.rentalId, { amount: args.feeCents, payment_intent: pi.id, attempt });
  log("info", "nonreturn_fee_charged", { attempt, feeCents: args.feeCents, paymentIntentId: pi.id });
  return done({ status: "charged", detail: "Non-return fee charged.", cents: args.feeCents, paymentIntentId: pi.id });
}

/** Best-effort SMS to the customer on fee failure — sendSms no-ops when Twilio isn't configured. */
async function notifyFeeFailed(db: SupabaseClient, rentalId: string, reference: string | null, feeCents: number) {
  try {
    const { data: pay } = await db.from("payments").select("customer_phone").eq("rental_id", rentalId).limit(1).maybeSingle();
    const phone = (pay as { customer_phone?: string | null } | null)?.customer_phone;
    if (!phone) return;
    await sendSms(db, {
      to: phone, rentalId,
      body: `Zapnivo: we couldn't charge the $${(feeCents / 100).toFixed(2)} non-return fee${reference ? ` for rental ${reference}` : ""}. Please return your power bank or contact support.zapnivo.com.`,
    });
  } catch { /* notification is best-effort */ }
}
