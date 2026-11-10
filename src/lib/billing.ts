import { createHmac, timingSafeEqual } from "node:crypto";
import { rentalChargeCents as chargeForMinutes, type PricingVersion } from "./pricing";

/** Pure billing math (integer cents) + signed receipt links. Never hardcodes prices or a tax rate. */

export type PricingRow = {
  id: string; approved: boolean; first_hour_cents: number; additional_hour_cents: number;
  first_24h_cap_cents: number; additional_day_cents: number | null; non_return_max_cents: number; non_return_after_hours: number;
};

export const pricingFromRow = (r: PricingRow): PricingVersion => ({
  id: r.id, approved: r.approved, firstHourCents: r.first_hour_cents, additionalHourCents: r.additional_hour_cents,
  first24hCapCents: r.first_24h_cap_cents, nonReturnMaxCents: r.non_return_max_cents, nonReturnAfterHours: r.non_return_after_hours,
  additionalDayCents: r.additional_day_cents,
});

export const PRICING_SELECT = "id,approved,first_hour_cents,additional_hour_cents,first_24h_cap_cents,additional_day_cents,non_return_max_cents,non_return_after_hours";

/**
 * Charge (before promo/tax) for a returned rental across `bankCount` banks.
 * Returns null when the rental ran past 24h and additional-day pricing is not finalised: the caller
 * must NOT auto-capture and should flag the rental for staff.
 */
export function rentalChargeCents(startedAt: Date | string, returnedAt: Date | string, pricing: PricingVersion, bankCount = 1): number | null {
  const s = new Date(startedAt).getTime(), e = new Date(returnedAt).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new RangeError("invalid timestamps");
  if (!Number.isInteger(bankCount) || bankCount < 1 || bankCount > 3) throw new RangeError("bankCount must be 1..3");
  const minutes = Math.max(0, (e - s) / 60000);
  const per = chargeForMinutes(minutes, pricing);
  return per === null ? null : per * bankCount;
}

/** Authorization hold = non-return maximum per bank. */
export const holdCents = (pricing: PricingVersion, bankCount: number) => pricing.nonReturnMaxCents * bankCount;

export type Promo = { percent_off: number | string | null; amount_off_cents: number | null };

/** Applies a promo to a subtotal. Result never goes below zero. */
export function applyPromo(subtotalCents: number, promo: Promo | null | undefined): { discountCents: number; netCents: number } {
  if (!promo || subtotalCents <= 0) return { discountCents: 0, netCents: Math.max(0, subtotalCents) };
  const pct = promo.percent_off === null || promo.percent_off === undefined ? null : Number(promo.percent_off);
  const raw = pct !== null ? Math.round((subtotalCents * pct) / 100) : promo.amount_off_cents ?? 0;
  const discountCents = Math.min(subtotalCents, Math.max(0, raw));
  return { discountCents, netCents: subtotalCents - discountCents };
}

/**
 * Tax is never computed from a hardcoded rate. When Stripe automatic tax is on, the hold session carries a tax
 * amount; the captured tax is that amount scaled to the share of the hold actually charged.
 */
export function proportionalTaxCents(holdTaxCents: number, holdSubtotalCents: number, netCents: number): number {
  if (holdTaxCents <= 0 || holdSubtotalCents <= 0 || netCents <= 0) return 0;
  return Math.min(holdTaxCents, Math.round((holdTaxCents * netCents) / holdSubtotalCents));
}

/* ───────────── signed receipt links (same stable-dev-secret pattern as helpdesk/access.ts) ───────────── */

const DEV_SECRET = "zapnivo-dev-only-access-secret";
const secret = () => process.env.HELPDESK_SECRET ?? (process.env.NODE_ENV === "production" ? null : DEV_SECRET);
const sign = (payload: string, key: string) => createHmac("sha256", key).update(`receipt:${payload}`).digest("base64url");

export function signReceipt(reference: string, email: string, ttlSeconds = 365 * 86400, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ r: reference, e: email.toLowerCase(), x: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

/** True only when the token is authentic, unexpired, and bound to exactly this reference and email. */
export function verifyReceipt(token: string | null | undefined, reference: string, email: string | null | undefined, now = Date.now()): boolean {
  const key = secret();
  if (!key || !token || !email) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const { r, e, x } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return r === reference && typeof e === "string" && e === email.toLowerCase() && x * 1000 > now;
  } catch { return false; }
}
