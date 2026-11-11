import { createHash, randomInt } from "node:crypto";

/**
 * Gift charging credits.
 *
 * PRODUCT DEFINITIONS — NOT FINAL PRICING. There is no admin gift-products table yet;
 * GIFT_PACKAGES below are seed definitions and MUST be reviewed/approved by staff
 * before real sales are enabled (set GIFT_SALES_ENABLED=1 to open purchases; default off).
 *
 * Redemption model: a paid gift grants `value_cents` of unit 'cent' entitlements to the
 * RECIPIENT's profile via entitlements.grant() (source_type 'gift_credit'). 'cent' credits
 * are ledgered but not yet consumed at rental checkout — applying them to a rental is a
 * documented follow-up. expires_at carries over from the gift row.
 */

export type GiftPackage = {
  id: string;
  label: string;
  /** What Stripe charges the purchaser, in cents. */
  priceCents: number;
  /** What the recipient's account is credited, in cents (value_cents on the row). */
  creditCents: number;
  description: string;
};

export const GIFT_PACKAGES: readonly GiftPackage[] = [
  {
    id: "gift-10",
    label: "Small charge-up",
    priceCents: 1000,
    creditCents: 1000,
    description: "$10 of charging credit — enough for a quick top-up charge.",
  },
  {
    id: "gift-25",
    label: "Day pass gift",
    priceCents: 2500,
    creditCents: 2500,
    description: "$25 of charging credit — covers a full day of charging.",
  },
  {
    id: "gift-50",
    label: "Power-up gift",
    priceCents: 5000,
    creditCents: 5000,
    description: "$50 of charging credit — a generous gift for a frequent charger.",
  },
] as const;

export const giftPackageById = (id: string) => GIFT_PACKAGES.find((p) => p.id === id) ?? null;

/** Purchases stay closed until staff flip this env var on (default disabled). */
export const giftSalesEnabled = () => process.env.GIFT_SALES_ENABLED === "1";

/** Gift codes are redeemable for one year from purchase. */
export const GIFT_VALIDITY_DAYS = 365;
export const MAX_GIFT_ATTEMPTS = 5;

export type GiftStatus = "pending_payment" | "paid" | "redeemed" | "expired" | "refunded";

export type GiftRow = {
  id: string;
  purchaser_email: string;
  purchaser_profile: string | null;
  package: string;
  value_cents: number | null;
  recipient_email: string | null;
  message: string | null;
  status: GiftStatus;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  expires_at: string | null;
  redeemed_by: string | null;
  redeemed_rental_id: string | null;
  redeemed_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  refunded_at: string | null;
  refunded_by: string | null;
  created_at: string;
};

/** Columns safe to return to clients — NEVER include code_hash. */
export const GIFT_PUBLIC_SELECT =
  "id,purchaser_email,purchaser_profile,package,value_cents,recipient_email,message,status,stripe_checkout_session_id,stripe_payment_intent_id,expires_at,redeemed_by,redeemed_rental_id,redeemed_at,attempts,last_attempt_at,refunded_at,refunded_by,created_at";

/* ── Redemption codes ────────────────────────────────────────────────────────
 * 12 chars from an unambiguous alphabet, displayed as XXXX-XXXX-XXXX.
 * Only the sha256 of the NORMALIZED code (uppercased, separators stripped) is
 * stored; the raw code is returned exactly once at purchase time.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

export function generateGiftCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export function normalizeGiftCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashGiftCode(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export const giftCodeHashFor = (raw: string) => hashGiftCode(normalizeGiftCode(raw));
