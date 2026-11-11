import { giftSalesEnabled } from "./gifts";
import { stripeConfigured } from "./stripe";

/**
 * Gift-card launch gate.
 *
 * Gift sales stay DISABLED until every legal item below is 'ready' AND payments
 * are configured. This module only REPORTS status — nothing here flips a switch.
 * The checklist is seeded honestly: items backed by shipped code are 'ready',
 * everything that still needs owner/legal review is 'pending' (or 'blocked').
 */

export type GiftChecklistCategory = "legal" | "payments" | "operations";
export type GiftChecklistStatus = "pending" | "ready" | "blocked";

export type GiftChecklistItem = {
  key: string;
  label: string;
  category: GiftChecklistCategory;
  status: GiftChecklistStatus;
  note: string;
};

export const GIFT_LAUNCH_CHECKLIST: readonly GiftChecklistItem[] = [
  // ── Legal ──
  { key: "gift_terms_doc", label: "Gift-card terms & conditions document", category: "legal", status: "pending", note: "No published gift-card terms yet; required before selling stored-value gifts in most states." },
  { key: "expiration_rules", label: "Expiration / escheatment rules", category: "legal", status: "pending", note: "Code sets GIFT_VALIDITY_DAYS=365; state escheatment and minimum-expiration rules need legal review before launch." },
  { key: "unused_balance_policy", label: "Unused balance & remainder policy", category: "legal", status: "pending", note: "Define what happens to unspent credit (expiry, dormancy, refund of remainder)." },
  { key: "refund_policy", label: "Gift purchase refund policy", category: "legal", status: "pending", note: "Refunds exist in schema (refunded_at/refunded_by) but the customer-facing policy is undecided." },
  { key: "transferability", label: "Transferability decision", category: "legal", status: "pending", note: "Bearer vs recipient claim policy is implemented; whether credits may be transferred/gifted onward is undecided." },
  { key: "state_requirements", label: "State gift-card law requirements review", category: "legal", status: "pending", note: "Multi-state stored-value rules (fees, expiration floors, escheatment) not yet reviewed." },
  { key: "consumer_disclosures", label: "Consumer disclosures", category: "legal", status: "pending", note: "Checkout disclosures for gift purchases (no cash value, expiry, redemption terms) not finalized." },
  { key: "tax_review", label: "Tax treatment review", category: "legal", status: "pending", note: "Whether gift-credit sales create unearned-revenue/tax obligations needs accountant review." },
  // ── Payments ──
  { key: "payments_configured", label: "Stripe payments configured", category: "payments", status: "pending", note: "Derived live from stripeConfigured() — flips to ready automatically when STRIPE_SECRET_KEY is set.", },
  { key: "webhook_fulfillment", label: "Paid gift fulfillment via webhook", category: "payments", status: "ready", note: "checkout.session.completed → fulfillGift marks paid, mints claim token, grants 'cent' credits atomically; idempotent on replay." },
  // ── Operations ──
  { key: "fraud_controls", label: "Fraud controls", category: "operations", status: "ready", note: "192-bit one-time claim tokens (sha256-only storage, 72h expiry), rate-limited claim endpoint, recipient email binding (claim_policy='recipient'), honeypot + rate-limited purchase form." },
  { key: "support_procedures", label: "Support procedures for gift issues", category: "operations", status: "pending", note: "Staff runbook for lost links, wrong-email claims, and refund handling not yet written." },
];

export type GiftLaunchStatus = {
  /** All non-legal gates + implemented technical pieces are in place. */
  technicalReady: boolean;
  /** Every legal checklist item is 'ready'. */
  legalApproved: boolean;
  /** Stripe keys are configured. */
  paymentsConfigured: boolean;
  status: "disabled" | "awaiting_legal" | "awaiting_payments" | "enabled";
};

export function giftLaunchStatus(): GiftLaunchStatus {
  const legalApproved = GIFT_LAUNCH_CHECKLIST.every((i) => i.category !== "legal" || i.status === "ready");
  const paymentsConfigured = stripeConfigured();
  const technicalReady = paymentsConfigured && GIFT_LAUNCH_CHECKLIST.every((i) => i.category !== "operations" || i.status !== "blocked");
  // Gate order: legal → payments → the sales switch. 'enabled' only when the env
  // flag is on AND both gates are green; this module never flips the flag itself.
  const status: GiftLaunchStatus["status"] = !legalApproved
    ? "awaiting_legal"
    : !paymentsConfigured
      ? "awaiting_payments"
      : giftSalesEnabled()
        ? "enabled"
        : "disabled";
  return { technicalReady, legalApproved, paymentsConfigured, status };
}
