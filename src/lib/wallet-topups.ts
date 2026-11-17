import type { SupabaseClient } from "@supabase/supabase-js";
import { grant } from "./monetization/entitlements";
import { auditLog } from "./audit";

type Checkout = { id?: unknown; payment_status?: unknown; amount_total?: unknown; currency?: unknown; payment_intent?: unknown; metadata?: unknown };

/** Stripe-confirmed funding only. The row and amount are always re-read server-side. */
export async function fulfillWalletTopup(db: SupabaseClient, checkout: Checkout): Promise<void> {
  const metadata = checkout.metadata as Record<string, unknown> | null;
  const id = metadata?.topup_id;
  if (typeof id !== "string" || typeof checkout.id !== "string") throw new Error("wallet_topup_missing_reference");
  const { data: row, error } = await db.from("wallet_topups")
    .select("id,profile_id,amount_cents,status,stripe_checkout_session_id,entitlement_grant_id")
    .eq("id", id).maybeSingle();
  if (error || !row) throw new Error("wallet_topup_not_found");
  if (row.status === "paid") return;
  if (row.status !== "pending" || row.profile_id !== metadata?.profile_id ||
      (row.stripe_checkout_session_id && row.stripe_checkout_session_id !== checkout.id) ||
      checkout.payment_status !== "paid" || checkout.currency !== "usd" || checkout.amount_total !== row.amount_cents) {
    throw new Error("wallet_topup_checkout_mismatch");
  }
  const { data: existing } = await db.from("entitlement_grants").select("id")
    .eq("source_type", "wallet_topup").eq("source_id", id).maybeSingle();
  let grantId: string | null = existing?.id ?? null;
  if (!grantId) {
    const result = await grant(db, { profileId: row.profile_id, kind: "wallet_topup", unit: "cent", amount: row.amount_cents,
      sourceType: "wallet_topup", sourceId: id, actor: "webhook", note: "Customer wallet top-up" });
    if (result.ok) grantId = result.grantId;
    else {
      const retry = await db.from("entitlement_grants").select("id").eq("source_type", "wallet_topup").eq("source_id", id).maybeSingle();
      grantId = retry.data?.id ?? null;
      if (!grantId) throw new Error("wallet_topup_grant_failed");
    }
  }
  const saved = await db.from("wallet_topups").update({ status: "paid", stripe_checkout_session_id: checkout.id,
    stripe_payment_intent_id: typeof checkout.payment_intent === "string" ? checkout.payment_intent : null,
    entitlement_grant_id: grantId, paid_at: new Date().toISOString() }).eq("id", id).eq("status", "pending");
  if (saved.error) throw new Error("wallet_topup_status_failed");
  await auditLog(row.profile_id, "wallet_topup_paid", "wallet_topup", id, { amount_cents: row.amount_cents });
}
