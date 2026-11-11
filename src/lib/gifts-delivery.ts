import { createHash, randomBytes } from "node:crypto";
import { subUrl } from "./site";

/**
 * Secure gift delivery — one-time claim links.
 *
 * When a gift with a recipient_email is paid, the Stripe webhook mints a random claim
 * token and stores ONLY its sha256 (claim_token_hash) plus a 72h expiry on the
 * gift_credits row. The raw token exists solely inside the emailed claim URL — it is
 * never persisted or logged. The recipient claims via POST /api/gifts/claim, which
 * calls the atomic claim_gift RPC (migration 0034/0040): validate hash + expiry +
 * status, mark redeemed, grant 'cent' credits — all in one transaction.
 *
 * Claim policies (gift_credits.claim_policy, migration 0040):
 *   'bearer'    — default; whoever holds the token may claim. Used for gifts with
 *                 no recipient_email (purchaser-share flow).
 *   'recipient' — set by the webhook when it mints a token for a gift that HAS a
 *                 recipient_email; claim_gift then requires the claiming profile's
 *                 email to match recipient_email (case-insensitive), returning
 *                 'recipient_mismatch' otherwise. Forwarded-secret links alone are
 *                 no longer sufficient for recipient-bound gifts.
 */

export const CLAIM_TOKEN_TTL_HOURS = 72;

/** 24 random bytes, base64url (~32 chars). High entropy — no need for an unambiguous alphabet. */
export function generateClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

/** sha256 hex of the raw token — the ONLY form ever stored. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const claimTokenExpiryIso = (fromMs = Date.now()) =>
  new Date(fromMs + CLAIM_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

/** Absolute claim URL on the customer portal. Token rides in the query string only. */
export function claimGiftUrl(token: string): string {
  return `${subUrl("customer", "/gifts/claim")}?t=${encodeURIComponent(token)}`;
}
