import type { SupabaseClient } from "@supabase/supabase-js";
import { GIFT_PACKAGES, giftSalesEnabled } from "../gifts";
import { getKioskAdapter, type KioskAdapter } from "../kiosk/adapter";
import { isStripeWebhookConfigured, stripeConfigured } from "../stripe";

/**
 * Payment readiness report for the admin dashboard.
 *
 * Checks configuration and catalog presence WITHOUT ever exposing secret material:
 * env values are reduced to booleans / a coarse mode, and DB checks are counts only.
 * Safe to serialize and return from an API route.
 */

export type StripeMode = "test" | "live" | "unknown";

/** Coarse Stripe mode derived from the key prefix — the key itself is never returned. */
export function stripeMode(): StripeMode {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return "unknown";
}

/** Tables the payment pipeline depends on for webhook dedupe + ledger reconciliation. */
export const RECONCILIATION_TABLES = ["stripe_events", "billing_ledger"] as const;

async function countActive(db: SupabaseClient, table: "membership_plans" | "prepaid_packages") {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("active", true);
  if (error) return { ok: false as const, count: 0 };
  return { ok: true as const, count: count ?? 0 };
}

async function tableExists(db: SupabaseClient, table: string) {
  const { error } = await db.from(table).select("id").limit(1);
  // PostgREST reports missing tables as PGRST205 / 42P01; any error means "not verifiable".
  return !error;
}

export type PaymentReadiness = {
  stripe: {
    /** STRIPE_SECRET_KEY is present (value never included). */
    secretKey: boolean;
    /** STRIPE_WEBHOOK_SECRET is present (value never included). */
    webhookSecret: boolean;
    /** Derived from the key prefix only. */
    mode: StripeMode;
  };
  /** Whether the webhook endpoint secret is configured; "unknown" also covers no-key. */
  webhookEndpoint: "configured" | "unknown";
  products: {
    /** Active membership plans. `null` count = table unreachable/unconfigured. */
    plans: number | null;
    packages: number | null;
  };
  /** Gift sales are env-gated by design: disabled → awaiting_legal → enabled. */
  gifts: "disabled" | "awaiting_legal" | "enabled";
  /** Kiosk adapter name, or "none" while NullKioskAdapter is in place (KIOSK_ADAPTER=none). */
  kiosk: string;
  /** Whether stripe_events + billing_ledger exist for webhook dedupe and ledger reconciliation. */
  reconciliation: "ok" | "missing" | "unknown";
  overall: "not_ready" | "partial" | "ready";
};

export async function paymentReadiness(
  db?: SupabaseClient | null,
  adapter: KioskAdapter = getKioskAdapter(),
): Promise<PaymentReadiness> {
  const secretKey = stripeConfigured();
  const webhookSecret = isStripeWebhookConfigured();

  let plans: number | null = null;
  let packages_: number | null = null;
  let reconciliation: PaymentReadiness["reconciliation"] = "unknown";
  if (db) {
    const [p, k] = await Promise.all([countActive(db, "membership_plans"), countActive(db, "prepaid_packages")]);
    plans = p.ok ? p.count : null;
    packages_ = k.ok ? k.count : null;
    const checks = await Promise.all(RECONCILIATION_TABLES.map((t) => tableExists(db, t)));
    reconciliation = checks.every(Boolean) ? "ok" : "missing";
  }

  // Gift packages exist as unapproved seeds (see src/lib/gifts.ts): with the env flag
  // off they are "awaiting_legal"; "disabled" is reserved for a future explicit kill switch.
  const gifts: PaymentReadiness["gifts"] = giftSalesEnabled() ? "enabled" : GIFT_PACKAGES.length ? "awaiting_legal" : "disabled";
  const kiosk = adapter.name === "none" || !adapter.name ? "none" : adapter.name;

  const hasProducts = (plans ?? 0) + (packages_ ?? 0) > 0;
  const coreReady = secretKey && webhookSecret && hasProducts && reconciliation === "ok";
  const overall: PaymentReadiness["overall"] = !secretKey ? "not_ready" : coreReady ? "ready" : "partial";

  return {
    stripe: { secretKey, webhookSecret, mode: stripeMode() },
    webhookEndpoint: webhookSecret ? "configured" : "unknown",
    products: { plans, packages: packages_ },
    gifts,
    kiosk,
    reconciliation,
    overall,
  };
}
