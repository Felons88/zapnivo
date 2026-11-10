import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Append-only billing ledger (migration 0016). One row per money movement:
 * rental captures, the $45 non-return fee, refunds (negative amount_cents), adjustments.
 * Rows are never updated in amount — only `status` transitions (pending -> succeeded/failed).
 * `idempotency_key` is UNIQUE, so a retried write fails with code "duplicate" instead of double-posting.
 */

export type LedgerKind = "rental_charge" | "non_return_fee" | "refund" | "adjustment";
export type LedgerStatus = "pending" | "succeeded" | "failed" | "refunded" | "cancelled";

export type LedgerEntry = {
  rentalId: string;
  kind: LedgerKind;
  /** Signed integer cents — charges positive, refunds negative. */
  amountCents: number;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
  status?: LedgerStatus;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export type LedgerResult = { ok: true; id: string | null } | { ok: false; code: string };

export async function appendLedger(db: SupabaseClient, e: LedgerEntry): Promise<LedgerResult> {
  const { data, error } = await db.from("billing_ledger").insert({
    rental_id: e.rentalId,
    kind: e.kind,
    amount_cents: e.amountCents,
    stripe_payment_intent_id: e.stripePaymentIntentId ?? null,
    stripe_charge_id: e.stripeChargeId ?? null,
    status: e.status ?? "succeeded",
    idempotency_key: e.idempotencyKey,
    metadata: e.metadata ?? {},
  }).select("id").maybeSingle();
  if (error) return { ok: false, code: error.code ?? "ledger_insert_failed" };
  return { ok: true, id: (data as { id?: string } | null)?.id ?? null };
}

/** Status transition only — amount and idempotency_key are immutable by convention. */
export async function markLedger(
  db: SupabaseClient,
  idempotencyKey: string,
  patch: { status: LedgerStatus; stripePaymentIntentId?: string | null; stripeChargeId?: string | null },
): Promise<boolean> {
  const row: Record<string, unknown> = { status: patch.status };
  if (patch.stripePaymentIntentId !== undefined) row.stripe_payment_intent_id = patch.stripePaymentIntentId;
  if (patch.stripeChargeId !== undefined) row.stripe_charge_id = patch.stripeChargeId;
  const { error } = await db.from("billing_ledger").update(row).eq("idempotency_key", idempotencyKey);
  return !error;
}

/** True when a pending or succeeded ledger row already exists for this rental+kind — the double-charge guard. */
export async function hasOpenLedgerEntry(db: SupabaseClient, rentalId: string, kind: LedgerKind): Promise<boolean> {
  const { data } = await db.from("billing_ledger").select("id")
    .eq("rental_id", rentalId).eq("kind", kind).in("status", ["pending", "succeeded"]).limit(1).maybeSingle();
  return Boolean(data);
}

/** Sum of succeeded amounts for a kind (e.g. the non-return fee lines on a receipt). Signed. */
export async function succeededLedgerCents(db: SupabaseClient, rentalId: string, kind: LedgerKind): Promise<number> {
  const { data } = await db.from("billing_ledger").select("amount_cents")
    .eq("rental_id", rentalId).eq("kind", kind).eq("status", "succeeded");
  return ((data ?? []) as { amount_cents: number }[]).reduce((a, r) => a + (r.amount_cents ?? 0), 0);
}
