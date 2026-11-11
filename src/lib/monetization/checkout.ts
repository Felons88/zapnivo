import { stripeCall, taxEnabled } from "@/lib/stripe";

/**
 * Stripe Checkout creators for monetization products. metadata.kind routes
 * webhook events; server-side rows (never client metadata) carry the truth.
 */

type Base = { email: string; successUrl: string; cancelUrl: string };

const priceData = (name: string, description: string, amountCents: number) => ({
  currency: "usd", unit_amount: amountCents,
  product_data: { name: name.slice(0, 250), description: description.slice(0, 500) },
  ...(taxEnabled() ? { tax_behavior: "exclusive" } : {}),
});

/** One-time membership plan purchase (interval='one_time'). */
export function createMembershipCheckout(i: Base & { planId: string; planName: string; amountCents: number; profileId: string }) {
  const metadata = { kind: "membership", plan_id: i.planId, profile_id: i.profileId };
  const body: Record<string, unknown> = {
    mode: "payment", customer_email: i.email, client_reference_id: i.planId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{ quantity: 1, price_data: priceData(`Zapnivo membership — ${i.planName}`, "Charging membership", i.amountCents) }],
    payment_intent_data: { receipt_email: i.email, metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `memcheckout_${i.profileId}_${i.planId}_${Date.now()}`);
}

/** Recurring membership via Stripe subscription mode. */
export function createSubscriptionCheckout(i: Base & { planId: string; planName: string; amountCents: number; interval: "month" | "year"; profileId: string }) {
  const metadata = { kind: "membership_subscription", plan_id: i.planId, profile_id: i.profileId };
  const body: Record<string, unknown> = {
    mode: "subscription", customer_email: i.email, client_reference_id: i.planId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd", unit_amount: i.amountCents, recurring: { interval: i.interval },
        product_data: { name: `Zapnivo membership — ${i.planName}`.slice(0, 250), description: "Charging membership".slice(0, 500) },
        ...(taxEnabled() ? { tax_behavior: "exclusive" } : {}),
      },
    }],
    subscription_data: { metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `subcheckout_${i.profileId}_${i.planId}_${Date.now()}`);
}

/** Gift credit purchase (one-time payment). giftId is our row id — code generated server-side. */
export function createGiftCheckout(i: Base & { giftId: string; packageLabel: string; amountCents: number }) {
  const metadata = { kind: "gift_credit", gift_id: i.giftId };
  const body: Record<string, unknown> = {
    mode: "payment", customer_email: i.email, client_reference_id: i.giftId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{ quantity: 1, price_data: priceData(`Zapnivo gift credit — ${i.packageLabel}`, "Gift charging credit", i.amountCents) }],
    payment_intent_data: { receipt_email: i.email, metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `giftcheckout_${i.giftId}`);
}

/** Prepaid package purchase (one-time). */
export function createPackageCheckout(i: Base & { purchaseId: string; packageId: string; packageName: string; amountCents: number; profileId: string }) {
  const metadata = { kind: "package", purchase_id: i.purchaseId, package_id: i.packageId, profile_id: i.profileId };
  const body: Record<string, unknown> = {
    mode: "payment", customer_email: i.email, client_reference_id: i.purchaseId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{ quantity: 1, price_data: priceData(`Zapnivo prepaid — ${i.packageName}`, "Prepaid charging package", i.amountCents) }],
    payment_intent_data: { receipt_email: i.email, metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `pkgcheckout_${i.purchaseId}`);
}

/** Group shared-credit pool funding (one-time). purchaseId is our group_credit_purchases row id — the webhook re-reads it server-side. */
export function createGroupFundingCheckout(i: Base & { purchaseId: string; groupId: string; groupName: string; amountCents: number }) {
  const metadata = { kind: "group_funding", purchase_id: i.purchaseId, group_id: i.groupId };
  const body: Record<string, unknown> = {
    mode: "payment", customer_email: i.email, client_reference_id: i.purchaseId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{ quantity: 1, price_data: priceData(`Zapnivo group credit — ${i.groupName}`, "Group charging credit pool", i.amountCents) }],
    payment_intent_data: { receipt_email: i.email, metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `groupfund_${i.purchaseId}`);
}

/** Event pass purchase (one-time; pass row pre-created). */
export function createEventPassCheckout(i: Base & { passId: string; eventName: string; amountCents: number }) {
  const metadata = { kind: "event_pass", pass_id: i.passId };
  const body: Record<string, unknown> = {
    mode: "payment", customer_email: i.email, client_reference_id: i.passId,
    success_url: i.successUrl, cancel_url: i.cancelUrl,
    line_items: [{ quantity: 1, price_data: priceData(`Zapnivo event pass — ${i.eventName}`, "Event charging pass", i.amountCents) }],
    payment_intent_data: { receipt_email: i.email, metadata },
    metadata,
  };
  if (taxEnabled()) body.automatic_tax = { enabled: true };
  return stripeCall<{ id: string; url: string | null }>("POST", "/checkout/sessions", body, `eventcheckout_${i.passId}`);
}
