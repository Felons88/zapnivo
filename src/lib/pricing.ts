/**
 * Server-controlled pricing configuration. Amounts are integer cents.
 * Clients must NEVER supply prices; checkout reads the active version server-side.
 * Status "proposed" means it may be DISPLAYED as pilot pricing but must not be used to charge
 * until the owner flips `approved` to true and additional-day pricing is finalised.
 */
export type PricingVersion = {
  id: string;
  approved: boolean;
  firstHourCents: number;
  additionalHourCents: number;
  first24hCapCents: number;
  nonReturnMaxCents: number;
  nonReturnAfterHours: number;
  additionalDayCents: number | null;
};

export const PRICING_V1: PricingVersion = {
  id: "pilot-2026-v1",
  approved: false,
  firstHourCents: 699,
  additionalHourCents: 699,       // CONFIRMED: $6.99 per STARTED hour, flat
  first24hCapCents: 24 * 699,     // no artificial cap — full 24h of hourly rates
  nonReturnMaxCents: 4500,        // CONFIRMED: $45 non-return fee (separate from rental charges)
  nonReturnAfterHours: 24,        // CONFIRMED: 24-hour return deadline
  additionalDayCents: null,
};

export const fmt = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Rental charge (excluding tax) for a completed rental. Returns null when it would need unapproved pricing. */
export function rentalChargeCents(minutes: number, p: PricingVersion = PRICING_V1): number | null {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("minutes must be >= 0");
  const hours = Math.max(1, Math.ceil(minutes / 60));
  const raw = p.firstHourCents + (hours - 1) * p.additionalHourCents;
  if (minutes <= 24 * 60) return raw; // flat per-started-hour; the 24h cap was retired with confirmed pricing
  if (p.additionalDayCents === null) return null;
  const extraDays = Math.ceil((minutes - 24 * 60) / (24 * 60));
  return Math.min(p.first24hCapCents + extraDays * p.additionalDayCents, p.nonReturnMaxCents);
}

/**
 * Advisory gate — intentionally NOT enforced at checkout (audit 2.7 decision).
 * Checkout already 503s without an APPROVED pricing version, and
 * additionalDayCents=null is a legitimate configuration meaning "no automatic
 * post-24h charge": captureOnReturn flags >24h rentals for manual review
 * instead of capturing. Treating null as a hard block would break that safe
 * manual-review path, so this stays a display/planning helper only.
 */
export function canChargeCustomers(p: PricingVersion = PRICING_V1) {
  return p.approved && p.additionalDayCents !== null;
}
