import type { SupabaseClient } from "@supabase/supabase-js";
import { trackServer } from "@/lib/analytics";
import { issueDispenseCommand } from "@/lib/kiosk/dispatch";
import { recordLog } from "@/lib/observability";
import { retrieveCheckoutSession, retrievePaymentIntent } from "@/lib/stripe";

type PayRow = { id: string; state: string; stripe_payment_intent_id: string | null; stripe_checkout_session_id: string | null };
type RentalRow = { id: string; payments: PayRow[] | PayRow | null };

const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
  recordLog(level, message, { service: "payments", route: "reconcile", attrs });

/**
 * Same transition a payment-confirmation webhook performs: rental authorized →
 * dispense_pending + the durable dispense command (idempotent). Used when the
 * Stripe event was missed, delayed, or the endpoint subscription lacks the type.
 */
async function markRentalPaid(
  db: SupabaseClient,
  rentalId: string,
  pay: PayRow,
  extra: Record<string, unknown> = {},
) {
  const revived = pay.state === "failed";
  await db.from("payments").update({
    ...(revived ? { state: "authorized", failure_code: null } : {}),
    ...extra,
  }).eq("id", pay.id);
  await db.from("rentals").update({ state: "dispense_pending" }).eq("id", rentalId)
    .in("state", revived ? ["authorized", "cancelled"] : ["authorized"]);
  await issueDispenseCommand(db, rentalId).catch((e) =>
    log("error", "reconcile_dispense_failed", { rentalId, reason: e instanceof Error ? e.message : "unknown" }));
  trackServer({ name: "rental_started", entityType: "rental", entityId: rentalId });
}

/**
 * Self-healing for rentals whose payment succeeded at Stripe but whose webhook
 * event never arrived (endpoint subscription gaps are the common cause in test
 * and prod). Asks Stripe directly — only touches rows with a Stripe ref.
 *
 * `customerId` scopes to one customer (the app's own poll uses this — bounded and
 * cheap); omit it for the cron sweep across all customers.
 */
export async function reconcileStuckPayments(
  db: SupabaseClient,
  opts: { customerId?: string; olderThanMs?: number; limit?: number } = {},
): Promise<{ checked: number; reconciled: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 20_000)).toISOString();
  let q = db.from("rentals")
    .select("id,payments(id,state,stripe_payment_intent_id,stripe_checkout_session_id)")
    .eq("state", "authorized").lt("created_at", cutoff)
    .order("created_at", { ascending: false }).limit(opts.limit ?? 10);
  if (opts.customerId) q = q.or(`customer_id.eq.${opts.customerId},renter_profile.eq.${opts.customerId}`);
  const { data } = await q;
  const rentals = (data ?? []) as unknown as RentalRow[];
  let reconciled = 0;

  for (const r of rentals) {
    const pay = (Array.isArray(r.payments) ? r.payments[0] : r.payments) ?? null;
    if (!pay || (pay.state !== "authorized" && pay.state !== "failed")) continue;
    try {
      if (pay.stripe_payment_intent_id) {
        // Native hold PI: requires_capture = authorized and awaiting capture.
        const pi = await retrievePaymentIntent(pay.stripe_payment_intent_id);
        if (pi.ok && pi.data.status === "requires_capture") {
          await markRentalPaid(db, r.id, pay);
          log("info", "reconcile_paid", { rentalId: r.id, via: "payment_intent" });
          reconciled++;
        }
      } else if (pay.stripe_checkout_session_id) {
        const s = await retrieveCheckoutSession(pay.stripe_checkout_session_id);
        if (s.ok && s.data.payment_status === "paid") {
          const piId = typeof s.data.payment_intent === "string" ? s.data.payment_intent : null;
          const tax = s.data.total_details?.amount_tax;
          await markRentalPaid(db, r.id, pay, {
            ...(piId ? { stripe_payment_intent_id: piId } : {}),
            ...(typeof tax === "number" ? { tax_cents: tax } : {}),
          });
          log("info", "reconcile_paid", { rentalId: r.id, via: "checkout_session" });
          reconciled++;
        }
      }
    } catch (e) {
      log("warning", "reconcile_error", { rentalId: r.id, reason: e instanceof Error ? e.message.slice(0, 140) : "unknown" });
    }
  }
  return { checked: rentals.length, reconciled };
}
