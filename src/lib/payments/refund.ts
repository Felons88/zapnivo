import type { SupabaseClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/audit";
import { recordLog } from "@/lib/observability";
import { fmt } from "@/lib/pricing";
import { triggerSecurityAlert } from "@/lib/email-extra-triggers";
import { releaseForRental } from "@/lib/monetization/credits";
import { appendLedger } from "./ledger";

/**
 * charge.refunded reconciliation for rental-side Stripe charges.
 *
 * Two charge families reach here:
 *  - the rental hold/capture PaymentIntent (a `payments` row), and
 *  - the separate non-return fee PaymentIntent (only a `billing_ledger`
 *    `non_return_fee` row carries its PI — `payments` has no kind column).
 *
 * Money is NEVER moved here — this only records what Stripe already did.
 *
 * Ledger convention: `billing_ledger` refund rows are negative cents and may
 * already exist for in-app refunds (the admin payments route writes
 * `refund:{stripe_refund_id}`). We therefore post only the DELTA between the
 * charge's cumulative `amount_refunded` and the sum of succeeded refund rows
 * for that rental+PI. The insert key embeds the cumulative total, so a replay
 * of the same charge.refunded state dedupes on the unique idempotency_key
 * while each new partial refund posts exactly once.
 *
 * Review flagging: a refund whose cents are NOT already in our ledger moved
 * outside the in-app flow (Stripe dashboard / API). Full unledgered refunds
 * additionally get a `rental_exceptions` row (kind 'external_refund', deduped
 * per charge) + audit + a staff security alert. Partials are ledgered and
 * logged only — documented choice: partial dashboard refunds are common
 * goodwill adjustments and don't strand entitlements the way a full refund
 * of a settled rental can. Committed entitlement credits are NOT auto-restored
 * (that is a money/credit decision for staff); open reservations are released
 * on any full refund via release_rental_reservations (idempotent no-op when
 * nothing is reserved).
 *
 * Rental state is deliberately untouched: there is no legal transition for
 * "externally refunded" in rental-state.ts, so reconciliation flags instead.
 */

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : null);

const TERMINAL_EXCEPTION_STATES = new Set(["resolved", "dismissed"]);

/** Sum of succeeded refund cents already ledgered for a rental+PI (positive number). */
async function ledgeredRefundCents(db: SupabaseClient, rentalId: string, piId: string): Promise<number> {
  const { data } = await db.from("billing_ledger").select("amount_cents")
    .eq("rental_id", rentalId).eq("kind", "refund")
    .eq("stripe_payment_intent_id", piId).eq("status", "succeeded");
  return ((data ?? []) as { amount_cents: number }[]).reduce((a, r) => a + Math.abs(num(r.amount_cents)), 0);
}

/**
 * Ensures an 'external_refund' rental_exceptions row exists for this charge.
 * Dedupe: any non-terminal exception already naming this stripe_charge_id
 * (falling back to the PI id) suppresses a duplicate — charge.refunded can be
 * reprocessed after a handler failure.
 */
async function ensureExternalRefundException(
  db: SupabaseClient,
  args: { rentalId: string; paymentId: string | null; charge: Obj; piId: string; refunded: number; captured: number; source: string },
): Promise<boolean> {
  const chargeId = str(args.charge.id);
  const { data: existing } = await db.from("rental_exceptions")
    .select("id,status,detail").eq("rental_id", args.rentalId).eq("kind", "external_refund").limit(50);
  const marker = chargeId ?? args.piId;
  const dup = ((existing ?? []) as { id: string; status: string; detail: Record<string, unknown> | null }[])
    .some((e) => !TERMINAL_EXCEPTION_STATES.has(e.status)
      && (e.detail?.stripe_charge_id === marker || e.detail?.stripe_payment_intent_id === args.piId));
  if (dup) return false;
  await db.from("rental_exceptions").insert({
    rental_id: args.rentalId, kind: "external_refund", status: "open",
    detail: {
      source: args.source, payment_id: args.paymentId,
      stripe_charge_id: chargeId, stripe_payment_intent_id: args.piId,
      amount_refunded_cents: args.refunded, amount_captured_cents: args.captured,
      note: "Refund issued outside the in-app flow (Stripe dashboard/API) — reconcile entitlements and settlement manually.",
    },
  });
  return true;
}

/** Staff alert for an unledgered (external) refund. Best-effort — never throws. */
async function alertStaffExternalRefund(db: SupabaseClient, args: {
  rentalId: string; paymentId: string | null; refunded: number; captured: number; full: boolean; source: string;
}) {
  try {
    const { data: staff } = await db.from("profiles").select("email").in("role", ["admin", "staff"]).limit(50);
    const detail = `${args.full ? "Full" : "Partial"} refund of ${fmt(args.refunded)} on ${args.source} (rental ${args.rentalId.slice(0, 8)}) was issued outside the app — ledger delta posted, review entitlements.`;
    for (const s of (staff ?? []) as { email: string }[]) {
      await triggerSecurityAlert(s.email, {
        severity: "HIGH", alertType: "External payment refund",
        accountRef: args.paymentId ? `payment:${args.paymentId.slice(0, 8)}` : `rental:${args.rentalId.slice(0, 8)}`,
        sourceRef: "stripe:charge.refunded",
        details: detail,
      }).catch(() => false);
    }
  } catch { /* alerting is best-effort */ }
}

/**
 * Shared reconciliation core: post the unledgered refund delta, release open
 * credit reservations on full refunds, and flag+alert on unledgered full
 * refunds. Returns the unledgered delta cents (0 when fully ledgered).
 */
async function reconcileDelta(
  db: SupabaseClient,
  args: { rentalId: string; paymentId: string | null; charge: Obj; piId: string; source: string },
): Promise<number> {
  const refunded = num(args.charge.amount_refunded);
  const captured = num(args.charge.amount_captured) || num(args.charge.amount);
  const full = refunded > 0 && captured > 0 && refunded >= captured;
  const chargeId = str(args.charge.id);

  const ledgered = await ledgeredRefundCents(db, args.rentalId, args.piId);
  const delta = Math.max(0, refunded - ledgered);
  if (delta > 0) {
    const res = await appendLedger(db, {
      rentalId: args.rentalId, kind: "refund", amountCents: -delta,
      stripePaymentIntentId: args.piId, stripeChargeId: chargeId, status: "succeeded",
      // Cumulative key: replay of the same amount_refunded dedupes; a new
      // partial refund (higher cumulative) posts a fresh delta row.
      idempotencyKey: `webhook_refund:${chargeId ?? args.piId}:${refunded}`,
      metadata: {
        payment_id: args.paymentId, source: "stripe_webhook",
        amount_refunded_cents: refunded, amount_captured_cents: captured,
        already_ledgered_cents: ledgered, full,
      },
    });
    if (!res.ok && res.code !== "23505") {
      recordLog("warning", "rental_refund_ledger_failed", {
        service: "payments", route: "payments/refund",
        attrs: { rentalId: args.rentalId, pi: args.piId.slice(0, 14), code: res.code },
      });
    }
    recordLog("warning", "rental_external_refund_delta", {
      service: "payments", route: "payments/refund",
      attrs: { rentalId: args.rentalId, pi: args.piId.slice(0, 14), delta, refunded, captured, full, source: args.source },
    });
  }

  if (full) {
    // A fully refunded rental must not keep credit reservations locked.
    await releaseForRental(db, args.rentalId).catch(() => 0);
  }

  if (delta > 0 && full) {
    const raised = await ensureExternalRefundException(db, {
      rentalId: args.rentalId, paymentId: args.paymentId, charge: args.charge,
      piId: args.piId, refunded, captured, source: args.source,
    });
    await auditLog(null, "stripe_external_refund", args.paymentId ? "payment" : "rental", args.paymentId ?? args.rentalId, {
      rental_id: args.rentalId, payment_id: args.paymentId, pi: args.piId,
      charge: chargeId, refunded_cents: refunded, captured_cents: captured, source: args.source, exception_raised: raised,
    });
    if (raised) await alertStaffExternalRefund(db, {
      rentalId: args.rentalId, paymentId: args.paymentId, refunded, captured, full, source: args.source,
    });
  } else if (delta > 0) {
    recordLog("info", "rental_partial_refund_unledgered", {
      service: "payments", route: "payments/refund",
      attrs: { rentalId: args.rentalId, pi: args.piId.slice(0, 14), delta, refunded, captured, source: args.source },
    });
  }
  return delta;
}

/**
 * charge.refunded for a rental `payments` row. Called AFTER the caller has
 * synced payments.amount_refunded_cents/state. Never throws for expected
 * reconciliation failures — the caller's requireWrite already guards the
 * payments write; ledger/exception problems are logged, not fatal.
 */
export async function reconcileRentalPaymentRefund(
  db: SupabaseClient,
  pay: { id: string; rental_id: string; state?: string },
  charge: Obj,
  piId: string,
): Promise<void> {
  try {
    await reconcileDelta(db, { rentalId: pay.rental_id, paymentId: pay.id, charge, piId, source: "rental_payment" });
  } catch (e) {
    recordLog("error", "rental_refund_reconcile_failed", {
      service: "payments", route: "payments/refund",
      attrs: { rentalId: pay.rental_id, pi: piId.slice(0, 14), err: e instanceof Error ? e.message.slice(0, 160) : "unknown" },
    });
  }
}

/**
 * charge.refunded for the separate non-return fee PI. Returns true when the
 * charge's PI belongs to a `non_return_fee` ledger row (handled — full refunds
 * also flip that row's status to 'refunded' so fee totals stop counting it).
 */
export async function reconcileNonReturnFeeRefund(db: SupabaseClient, charge: Obj, piId: string): Promise<boolean> {
  try {
    const { data } = await db.from("billing_ledger").select("id,rental_id,status")
      .eq("kind", "non_return_fee").eq("stripe_payment_intent_id", piId)
      .in("status", ["pending", "succeeded"]).limit(5);
    const rows = (data ?? []) as { id: string; rental_id: string; status: string }[];
    const fee = rows.find((r) => r.status === "succeeded") ?? rows[0];
    if (!fee) return false;

    const refunded = num(charge.amount_refunded);
    const captured = num(charge.amount_captured) || num(charge.amount);
    const full = refunded > 0 && captured > 0 && refunded >= captured;

    const delta = await reconcileDelta(db, {
      rentalId: fee.rental_id, paymentId: null, charge, piId, source: "non_return_fee",
    });
    if (full && fee.status === "succeeded") {
      await db.from("billing_ledger").update({ status: "refunded" }).eq("id", fee.id).eq("status", "succeeded");
    }
    if (delta > 0 || full) {
      recordLog("info", "nonreturn_fee_refund_reconciled", {
        service: "payments", route: "payments/refund",
        attrs: { rentalId: fee.rental_id, pi: piId.slice(0, 14), refunded, captured, full, delta },
      });
    }
    return true;
  } catch (e) {
    recordLog("error", "nonreturn_fee_refund_failed", {
      service: "payments", route: "payments/refund",
      attrs: { pi: piId.slice(0, 14), err: e instanceof Error ? e.message.slice(0, 160) : "unknown" },
    });
    return false;
  }
}
