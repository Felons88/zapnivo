import { fmt } from "./pricing";
import { sendToCustomer } from "./email-triggers";

/**
 * Gift credit emails.
 *
 * giftPurchaseConfirmation — sent when checkout is CREATED ("purchase initiated"),
 *   deliberately without the redemption code: payment isn't confirmed yet and the raw
 *   code is only ever shown once, in the purchase API response.
 *
 * GAP: giftReceived is exported for the Stripe webhook to call once a gift flips to
 *   'paid' — the webhook file is owned elsewhere and currently only marks status.
 *   Until that's wired, recipients are not notified automatically; the purchaser must
 *   share the code themselves.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function giftPurchaseConfirmation(
  purchaserEmail: string,
  packageLabel: string,
  creditCents: number,
  recipientEmail: string | null,
): Promise<boolean> {
  const to = recipientEmail ? ` for ${recipientEmail}` : "";
  const body = [
    `Thanks for your Zapnivo gift purchase — ${packageLabel} (${fmt(creditCents)} of charging credit)${to}.`,
    "",
    "Your payment is being processed. Once it completes, your gift code will be ready in your account under Gifts.",
    "Keep that code private — anyone with it can redeem the credit.",
    "",
    "— The Zapnivo team",
  ].join("\n");
  const html = `<p>Thanks for your Zapnivo gift purchase — <strong>${escape(packageLabel)}</strong> (${fmt(creditCents)} of charging credit)${to ? ` for <strong>${escape(recipientEmail!)}</strong>` : ""}.</p>
<p>Your payment is being processed. Once it completes, your gift code will be ready in your account under <strong>Gifts</strong>.</p>
<p>Keep that code private — anyone with it can redeem the credit.</p>
<p>— The Zapnivo team</p>`;
  return sendToCustomer(purchaserEmail, `Your Zapnivo gift — ${packageLabel}`, body, html, null, { template: "gift_purchase_confirmation", event: "gift.purchase_initiated" });
}

/**
 * Recipient notification — intended for the Stripe webhook (kind 'gift_credit') once
 * status flips to 'paid'. NOT YET WIRED: see module docstring.
 */
export async function giftReceived(
  recipientEmail: string,
  packageLabel: string,
  code: string,
  message: string | null,
): Promise<boolean> {
  const note = message ? `\n\n"${message}"` : "";
  const body = [
    `You've been sent a Zapnivo charging gift — ${packageLabel}.`,
    "",
    `Your gift code is: ${code}`,
    "",
    "Sign in to your Zapnivo account, open Gifts, and enter the code to add the credit.",
    note,
    "",
    "— The Zapnivo team",
  ].join("\n");
  const html = `<p>You've been sent a Zapnivo charging gift — <strong>${escape(packageLabel)}</strong>.</p>
<p>Your gift code is: <strong style="font-family:monospace;letter-spacing:0.08em">${escape(code)}</strong></p>
<p>Sign in to your Zapnivo account, open <strong>Gifts</strong>, and enter the code to add the credit.</p>
${message ? `<p style="font-style:italic">"${escape(message)}"</p>` : ""}
<p>— The Zapnivo team</p>`;
  return sendToCustomer(recipientEmail, `You've got a Zapnivo charging gift — ${packageLabel}`, body, html, null, { template: "gift_received", event: "gift.received" });
}

/**
 * Recipient secure-delivery email — sent by the Stripe webhook (kind 'gift_credit')
 * once a gift with a recipient_email flips to 'paid'. Carries a one-time claim LINK
 * (never the redemption code or the raw token beyond the URL itself). Idempotent in
 * practice: the webhook only sends it when it mints the claim token (claim_token_hash
 * is null-guarded), so webhook retries can't double-send.
 */
export async function giftClaimLink(
  recipientEmail: string,
  packageLabel: string,
  message: string | null,
  claimUrl: string,
): Promise<boolean> {
  const note = message ? `\n\n"${message}"` : "";
  const body = [
    `You've been sent a Zapnivo charging gift — ${packageLabel}.`,
    "",
    "Claim it here (sign in first if asked):",
    claimUrl,
    "",
    "This link works once and expires in 72 hours.",
    note,
    "",
    "— The Zapnivo team",
  ].join("\n");
  const html = `<p>You've been sent a Zapnivo charging gift — <strong>${escape(packageLabel)}</strong>.</p>
<p><a href="${escape(claimUrl)}" style="display:inline-block;background:#1c2b1c;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Claim your gift</a></p>
<p style="word-break:break-all"><a href="${escape(claimUrl)}">${escape(claimUrl)}</a></p>
<p style="font-size:13px;color:#555">This link works once and expires in 72 hours.</p>
${message ? `<p style="font-style:italic">"${escape(message)}"</p>` : ""}
<p>— The Zapnivo team</p>`;
  return sendToCustomer(recipientEmail, `You've got a Zapnivo charging gift — ${packageLabel}`, body, html, null, { template: "gift_claim_link", event: "gift.received" });
}

/** Confirmation to the redeemer that their credit landed (sent from the redeem route). */
export async function giftRedeemedConfirmation(
  profileEmail: string,
  packageLabel: string,
  creditCents: number,
): Promise<boolean> {
  const body = [
    `Your Zapnivo gift code for ${packageLabel} was redeemed successfully.`,
    "",
    `${fmt(creditCents)} of charging credit is now on your account.`,
    "",
    "— The Zapnivo team",
  ].join("\n");
  const html = `<p>Your Zapnivo gift code for <strong>${escape(packageLabel)}</strong> was redeemed successfully.</p>
<p><strong>${fmt(creditCents)}</strong> of charging credit is now on your account.</p>
<p>— The Zapnivo team</p>`;
  return sendToCustomer(profileEmail, `Gift redeemed — ${fmt(creditCents)} charging credit added`, body, html, null, { template: "gift_redeemed", event: "gift.redeemed" });
}
