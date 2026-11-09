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
  additionalHourCents: 200,
  first24hCapCents: 1299,
  nonReturnMaxCents: 4500,
  nonReturnAfterHours: 72,
  additionalDayCents: null,
};

export const fmt = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Rental charge (excluding tax) for a completed rental. Returns null when it would need unapproved pricing. */
export function rentalChargeCents(minutes: number, p: PricingVersion = PRICING_V1): number | null {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("minutes must be >= 0");
  const hours = Math.max(1, Math.ceil(minutes / 60));
  const raw = p.firstHourCents + (hours - 1) * p.additionalHourCents;
  if (minutes <= 24 * 60) return Math.min(raw, p.first24hCapCents);
  if (p.additionalDayCents === null) return null;
  const extraDays = Math.ceil((minutes - 24 * 60) / (24 * 60));
  return Math.min(p.first24hCapCents + extraDays * p.additionalDayCents, p.nonReturnMaxCents);
}

export function canChargeCustomers(p: PricingVersion = PRICING_V1) {
  return p.approved && p.additionalDayCents !== null;
}
