import { z } from "zod";

/**
 * Shared validation + completeness rules for admin edits of membership_plans and
 * prepaid_packages. Used by the PATCH routes under /api/admin/monetization so a
 * plan/package can never be activated while missing fields a customer checkout
 * would need (name, positive price, valid interval, positive entitlement/units).
 */

export const PLAN_INTERVALS = ["month", "year", "one_time"] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

/** Hard ceiling for any catalog price — $100,000. */
export const MAX_PRICE_CENTS = 10_000_000;
export const MAX_NAME_LENGTH = 120;

const nonEmptyName = z.string().trim().min(1, "Name is required.").max(MAX_NAME_LENGTH, "Name is too long.");
const positivePrice = z.number().int("Price must be a whole number of cents.").min(1, "Price must be greater than zero.").max(MAX_PRICE_CENTS, "Price is too large.");

/**
 * Plan `benefit` JSON → the entitlement the webhook would grant. Mirrors
 * benefitToGrant in src/lib/monetization/webhook.ts (kept private there; webhook.ts
 * is owned elsewhere so the rule is duplicated here for validation only).
 */
export function entitlementFromBenefit(benefit: unknown): { unit: "rental" | "minute" | "cent"; amount: number } | null {
  const b = benefit as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  if (typeof b.rentals === "number" && b.rentals > 0) return { unit: "rental", amount: Math.floor(b.rentals) };
  if (typeof b.rental_minutes === "number" && b.rental_minutes > 0) return { unit: "minute", amount: Math.floor(b.rental_minutes) };
  if (typeof b.credit_cents === "number" && b.credit_cents > 0) return { unit: "cent", amount: Math.floor(b.credit_cents) };
  return null;
}

/** Benefit payload accepted on PATCH: at least one positive entitlement, no negatives. */
export const benefitPatchSchema = z
  .object({
    rentals: z.number().int().min(0).max(1_000_000).optional(),
    rental_minutes: z.number().int().min(0).max(100_000_000).optional(),
    credit_cents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => typeof v === "number" && v > 0), {
    message: "Benefit needs at least one positive entitlement (rentals, rental_minutes or credit_cents).",
  });
export type BenefitPatch = z.infer<typeof benefitPatchSchema>;

export const planPatchSchema = z
  .object({
    active: z.boolean().optional(),
    name: nonEmptyName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    price_cents: positivePrice.optional(),
    interval: z.enum(PLAN_INTERVALS).optional(),
    benefit: benefitPatchSchema.optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "Nothing to update." });
export type PlanPatch = z.infer<typeof planPatchSchema>;

export const packagePatchSchema = z
  .object({
    active: z.boolean().optional(),
    name: nonEmptyName.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    price_cents: positivePrice.optional(),
    units: z.number().int("Units must be a whole number.").min(1, "Units must be greater than zero.").max(1_000_000).optional(),
    validity_days: z.number().int().min(1).max(3650).nullable().optional(),
    sort: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "Nothing to update." });
export type PackagePatch = z.infer<typeof packagePatchSchema>;

export type PlanRow = {
  name?: string | null; price_cents?: number | null; interval?: string | null; benefit?: unknown;
};
export type PackageRow = {
  name?: string | null; price_cents?: number | null; units?: number | null; kind?: string | null;
};

export type Completeness = { complete: boolean; missing: string[] };

const ok = (missing: string[]): Completeness => ({ complete: missing.length === 0, missing });

/**
 * Fields a membership plan needs before it can be sold/activated: non-empty name,
 * positive price within ceiling, a known billing interval, and a benefit that maps
 * to a positive entitlement.
 */
export function planCompleteness(row: PlanRow): Completeness {
  const missing: string[] = [];
  if (!row.name || !row.name.trim()) missing.push("name");
  if (typeof row.price_cents !== "number" || !Number.isInteger(row.price_cents) || row.price_cents < 1 || row.price_cents > MAX_PRICE_CENTS) missing.push("price_cents");
  if (!row.interval || !(PLAN_INTERVALS as readonly string[]).includes(row.interval)) missing.push("interval");
  if (!entitlementFromBenefit(row.benefit)) missing.push("benefit");
  return ok(missing);
}

/** Fields a prepaid package needs before it can be sold/activated. */
export function packageCompleteness(row: PackageRow): Completeness {
  const missing: string[] = [];
  if (!row.name || !row.name.trim()) missing.push("name");
  if (typeof row.price_cents !== "number" || !Number.isInteger(row.price_cents) || row.price_cents < 1 || row.price_cents > MAX_PRICE_CENTS) missing.push("price_cents");
  if (typeof row.units !== "number" || !Number.isInteger(row.units) || row.units < 1) missing.push("units");
  if (!row.kind || !row.kind.trim()) missing.push("kind");
  return ok(missing);
}
