/**
 * Payment-source seam. Rentals are looked up in our database; when Stripe is linked, a
 * PaymentSource returns the LIVE truth for a PaymentIntent (captured / refunded) so support
 * answers never rely on stale rows.
 *
 * TO LINK STRIPE LATER:
 *  1. `npm i stripe`; set STRIPE_SECRET_KEY (server-only) and STRIPE_WEBHOOK_SECRET.
 *  2. Implement `StripePaymentSource.summarize` (see sketch below) and return it from `getPaymentSource`.
 *  3. Add the webhook route that verifies the signature and writes payments/refunds idempotently.
 * Nothing else in the support flow or the AI assistant needs to change.
 *
 *   const pi = await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
 *   const charge = pi.latest_charge as Stripe.Charge | null;
 *   return { status: pi.status, capturedCents: charge?.amount_captured ?? 0, refundedCents: charge?.amount_refunded ?? 0 };
 */
export type PaymentSummary = { status: string; capturedCents: number; refundedCents: number };

export interface PaymentSource {
  summarize(paymentIntentId: string): Promise<PaymentSummary | null>;
}

/** Default until Stripe is linked: no live data, callers fall back to database values. */
export class NotConfiguredPaymentSource implements PaymentSource {
  async summarize(_paymentIntentId: string): Promise<PaymentSummary | null> { return null; }
}

export const stripeLinked = () => Boolean(process.env.STRIPE_SECRET_KEY);

export function getPaymentSource(): PaymentSource {
  // When stripeLinked() and StripePaymentSource exists, return it here.
  return new NotConfiguredPaymentSource();
}

/**
 * Refund issuing seam. Stripe refunds are issued with an IDEMPOTENCY KEY equal to the refund request id,
 * so retries after a timeout can never refund twice.
 *
 *   const r = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountCents },
 *                                         { idempotencyKey: `refund_${idempotencyKey}` });
 *   return { ok: true, id: r.id };
 */
export type RefundOutcome = { ok: true; id: string } | { ok: false; reason: "not_configured" | "rejected" | "error"; message: string };
export interface RefundProvider {
  refund(args: { paymentIntentId: string; amountCents: number; idempotencyKey: string }): Promise<RefundOutcome>;
}
export class NotConfiguredRefundProvider implements RefundProvider {
  async refund(_args: { paymentIntentId: string; amountCents: number; idempotencyKey: string }): Promise<RefundOutcome> {
    return { ok: false, reason: "not_configured", message: "Stripe is not linked yet. The refund is approved and queued; issue it in Stripe and record it as issued manually." };
  }
}
export function getRefundProvider(): RefundProvider {
  // When stripeLinked() and StripeRefundProvider exists, return it here.
  return new NotConfiguredRefundProvider();
}
