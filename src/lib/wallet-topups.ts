import type { SupabaseClient } from "@supabase/supabase-js";
import { grant } from "./monetization/entitlements";
import { auditLog } from "./audit";

type Checkout = { id?: unknown; payment_status?: unknown; amount_total?: unknown; currency?: unknown; payment_intent?: unknown; metadata?: unknown };
type Intent = { id?: unknown; status?: unknown; amount_received?: unknown; currency?: unknown; metadata?: unknown };

type VerifiedTopup = { id: string; profileId: string; amountCents: number; intentId: string | null; sessionId: string | null };

/** Stripe-confirmed funding only. The row and amount are always re-read server-side. */
export async function fulfillWalletTopup(db: SupabaseClient, checkout: Checkout): Promise<void> {
  const metadata = checkout.metadata as Record<string, unknown> | null;
  const id = metadata?.topup_id;
  if (typeof id !== "string" || typeof checkout.id !== "string") throw new Error("wallet_topup_missing_reference");
  if (checkout.payment_status !== "paid" || checkout.currency !== "usd" || typeof checkout.amount_total !== "number" || typeof metadata?.profile_id !== "string") throw new Error("wallet_topup_checkout_mismatch");
  await creditVerifiedTopup(db, { id, profileId: metadata.profile_id, amountCents: checkout.amount_total,
    intentId: typeof checkout.payment_intent === "string" ? checkout.payment_intent : null, sessionId: checkout.id });
}

/** Called only from the verified Stripe webhook after native card confirmation. */
export async function fulfillWalletTopupIntent(db: SupabaseClient, intent: Intent): Promise<void> {
  const metadata = intent.metadata as Record<string, unknown> | null;
  if (typeof intent.id !== "string" || typeof metadata?.topup_id !== "string" || typeof metadata.profile_id !== "string" ||
      intent.status !== "succeeded" || intent.currency !== "usd" || typeof intent.amount_received !== "number") throw new Error("wallet_topup_intent_mismatch");
  await creditVerifiedTopup(db, { id: metadata.topup_id, profileId: metadata.profile_id,
    amountCents: intent.amount_received, intentId: intent.id, sessionId: null });
}

async function creditVerifiedTopup(db: SupabaseClient, payment: VerifiedTopup): Promise<void> {
  const { id } = payment;
  const { data: row, error } = await db.from("wallet_topups")
    .select("id,profile_id,amount_cents,status,stripe_checkout_session_id,stripe_payment_intent_id,entitlement_grant_id")
    .eq("id", id).maybeSingle();
  if (error || !row) throw new Error("wallet_topup_not_found");
  if (row.status === "paid") return;
  // Legacy hosted Checkout is credited by checkout.session.completed instead.
  if (!payment.sessionId && row.stripe_checkout_session_id) return;
  if (row.status !== "pending" || row.profile_id !== payment.profileId || row.amount_cents !== payment.amountCents ||
      (payment.sessionId && row.stripe_checkout_session_id && row.stripe_checkout_session_id !== payment.sessionId) ||
      (row.stripe_payment_intent_id && row.stripe_payment_intent_id !== payment.intentId) ||
      (!payment.sessionId && row.stripe_payment_intent_id !== payment.intentId)) {
    throw new Error("wallet_topup_payment_mismatch");
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
  const saved = await db.from("wallet_topups").update({ status: "paid", ...(payment.sessionId ? { stripe_checkout_session_id: payment.sessionId } : {}),
    stripe_payment_intent_id: payment.intentId,
    entitlement_grant_id: grantId, paid_at: new Date().toISOString() }).eq("id", id).eq("status", "pending").select("id");
  if (saved.error) throw new Error("wallet_topup_status_failed");
  await auditLog(row.profile_id, "wallet_topup_paid", "wallet_topup", id, { amount_cents: row.amount_cents });
  // Only the delivery that actually flipped pending -> paid sends the receipt (replays stay silent).
  if (saved.data?.length) await notifyTopupPaid(db, row.profile_id, row.amount_cents).catch(() => undefined);
}

/** Makes sure the customer's prepaid card exists and emails + pushes the receipt. Best-effort: credit is already granted. */
async function notifyTopupPaid(db: SupabaseClient, profileId: string, amountCents: number) {
  const { getOrIssueCard, formatExpiry } = await import("./prepaid-card");
  const card = await getOrIssueCard(db, profileId);
  const { data: profile } = await db.from("profiles").select("email,full_name").eq("id", profileId).maybeSingle();
  const p = profile as { email: string; full_name: string | null } | null;
  const { fmt } = await import("./pricing");
  const first = p?.full_name?.trim().split(/\s+/)[0];
  const { pushToUser } = await import("./push");
  await pushToUser(profileId, {
    title: `${fmt(amountCents)} added to your wallet`,
    body: `${first ? `${first}, your` : "Your"} balance is topped up${card ? ` — card •••• ${card.pan.slice(-4)}` : ""} and ready at any Zapnivo machine.`,
    data: { type: "wallet" },
  }).catch(() => 0);
  const email = p?.email;
  if (!email || email.endsWith("@mobile.zapnivo.com")) return;
  const { sendToCustomer } = await import("./email-triggers");
  await sendToCustomer(email, `${fmt(amountCents)} added to your Zapnivo card`,
    `Your top-up of ${fmt(amountCents)} was received and is on your Zapnivo prepaid card${card ? ` ending ${card.pan.slice(-4)} (expires ${formatExpiry(card)})` : ""}. It works at Zapnivo machines and machines we service. Open the app to see your balance and add the card to your phone wallet.`,
    null, null, { sender: "support", event: "wallet_topup_paid" });
}

/** payment_intent.payment_failed for an in-app top-up: the row is closed out; no credit was ever granted. */
export async function failWalletTopupIntent(db: SupabaseClient, intent: { id?: unknown; metadata?: unknown }): Promise<void> {
  const metadata = intent.metadata as Record<string, unknown> | null;
  if (typeof intent.id !== "string" || typeof metadata?.topup_id !== "string") return;
  await db.from("wallet_topups").update({ status: "failed" }).eq("id", metadata.topup_id).eq("status", "pending").eq("stripe_payment_intent_id", intent.id);
  await auditLog(typeof metadata.profile_id === "string" ? metadata.profile_id : null, "wallet_topup_failed", "wallet_topup", metadata.topup_id);
}
