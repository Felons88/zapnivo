import { sendToCustomer, stamp } from "./email-triggers";
import { fmt } from "./pricing";
import { subUrl } from "./site";

/**
 * Monetization lifecycle emails (memberships + prepaid packages). Queued through
 * the same helpdesk outbox as rental mail via sendToCustomer — event/template
 * names are prefixed `monetization.` so they stay distinct from other agents'
 * notifications and the email studio can route/filter them.
 *
 * WIRING GAP: membership activation/payment-failed emails are triggered by the
 * Stripe webhook (src/lib/monetization/webhook.ts), which is owned elsewhere —
 * these functions are exported and ready, but nothing calls
 * sendMembershipActivated / sendMembershipPaymentFailed yet. Call them from the
 * webhook (or a follow-up hook) when that file is free to edit.
 * sendMembershipCancelled IS wired — the customer cancel route calls it.
 */

const META = { template: "monetization", sender: "billing" } as const;
const accountUrl = () => subUrl("customer", "/charging");

const unitLabel = (kind: string, units: number) =>
  kind === "rental" ? `${units} free rental${units === 1 ? "" : "s"}`
  : kind === "minute" ? `${units} prepaid minute${units === 1 ? "" : "s"}`
  : `${fmt(units)} charging credit`;

export async function sendMembershipActivated(args: {
  email: string; planName: string; interval: string; periodEnd: string | null; benefitSummary?: string | null;
}) {
  const cycle = args.interval === "year" ? "year" : args.interval === "month" ? "month" : null;
  const subject = `Your Zapnivo ${cycle ? `${cycle}ly ` : ""}membership is active`;
  const body = [
    `Hi,`,
    ``,
    `Your Zapnivo membership — ${args.planName} — is now active.`,
    args.benefitSummary ? `Includes: ${args.benefitSummary}.` : null,
    args.periodEnd ? `Current period ends ${stamp(args.periodEnd)}.` : `This is a one-time membership; included benefits expire on their own schedule.`,
    ``,
    `Manage it any time: ${accountUrl()}`,
    ``,
    `— Zapnivo`,
  ].filter((l): l is string => l !== null).join("\n");
  return sendToCustomer(args.email, subject, body, null, null, { ...META, event: "monetization.membership_activated" });
}

export async function sendMembershipPaymentFailed(args: { email: string; planName?: string | null }) {
  const subject = "We couldn't process your Zapnivo membership payment";
  const body = [
    `Hi,`,
    ``,
    `A payment${args.planName ? ` for your ${args.planName} membership` : " for your Zapnivo membership"} didn't go through.`,
    `Stripe will retry automatically. If the retries keep failing, your membership moves to past due and benefits may pause.`,
    ``,
    `Update your payment method or check your membership: ${accountUrl()}`,
    ``,
    `— Zapnivo`,
  ].join("\n");
  return sendToCustomer(args.email, subject, body, null, null, { ...META, event: "monetization.membership_payment_failed" });
}

export async function sendMembershipCancelled(args: { email: string; planName?: string | null; atPeriodEnd?: boolean }) {
  const subject = "Your Zapnivo membership was cancelled";
  const body = [
    `Hi,`,
    ``,
    args.atPeriodEnd
      ? `Your${args.planName ? ` ${args.planName}` : ""} membership will end at the close of the current billing period. Benefits you already have stay valid until they expire.`
      : `Your${args.planName ? ` ${args.planName}` : ""} membership has been cancelled. One-time benefits already granted stay valid until they expire; no refund is issued for unused time.`,
    ``,
    `Your account: ${accountUrl()}`,
    ``,
    `— Zapnivo`,
  ].join("\n");
  return sendToCustomer(args.email, subject, body, null, null, { ...META, event: "monetization.membership_cancelled" });
}

export async function sendPackagePurchased(args: {
  email: string; packageName: string; kind: string; units: number; validityDays: number | null;
}) {
  const subject = `Your Zapnivo prepaid package is ready — ${args.packageName}`;
  const body = [
    `Hi,`,
    ``,
    `Thanks for your purchase. ${unitLabel(args.kind, args.units)} has been added to your account.`,
    args.validityDays ? `It stays valid for ${args.validityDays} day${args.validityDays === 1 ? "" : "s"}.` : `It doesn't expire.`,
    ``,
    `See your balance and history: ${accountUrl()}`,
    ``,
    `— Zapnivo`,
  ].join("\n");
  return sendToCustomer(args.email, subject, body, null, null, { ...META, event: "monetization.package_purchased" });
}
