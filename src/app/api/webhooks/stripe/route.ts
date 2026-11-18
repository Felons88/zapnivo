import { NextResponse } from "next/server";
import { triggerPaymentReceipt } from "@/lib/email-triggers";
import { triggerPaymentDispute, triggerPaymentFailedHtml } from "@/lib/email-extra-triggers";
import { fmt } from "@/lib/pricing";
import { nonReturnDeadlineIso } from "@/lib/payments/nonreturn-deadline";
import { reconcileNonReturnFeeRefund, reconcileRentalPaymentRefund } from "@/lib/payments/refund";
import { verifyStripeSignature } from "@/lib/stripe";
import { handleAdChargeRefunded, handleAdCheckoutCompleted, handleAdPaymentIntent } from "@/lib/ads/billing";
import { handleMonetizationDispute, handleMonetizationEvent, handleMonetizationRefund } from "@/lib/monetization/webhook";
import { serviceClient } from "@/lib/supabase";
import { issueDispenseCommand } from "@/lib/kiosk/dispatch";
import { trackServer } from "@/lib/analytics";
import { newTraceId, recordLog, recordSpan, reportError } from "@/lib/observability";

/** Stripe webhook — verifies the signature (no SDK) and fires the payment_receipt email on success. */
export async function POST(req: Request) {
  const traceId = newTraceId();
  const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
    recordLog(level, message, { service: "payments", route: "webhooks/stripe", traceId, attrs });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhooks not configured" }, { status: 503 });
  const payload = await req.text();
  const check = verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret);
  if (!check.ok) return NextResponse.json({ error: "Bad signature" }, { status: 400 });

  let event: StripeEvent;
  try { event = JSON.parse(payload) as StripeEvent; } catch { return NextResponse.json({ error: "Bad payload" }, { status: 400 }); }
  if (!event?.id || !event.type || !event.data?.object) return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  log("info", "stripe_event_received", { eventId: event.id, eventType: event.type });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  // Dedupe: the primary key rejects a replayed event id.
  const claim = await db.from("stripe_events").insert({ id: event.id, type: event.type });
  if (claim.error) {
    if (claim.error.code === "23505") { log("info", "stripe_event_duplicate", { eventId: event.id, eventType: event.type }); return NextResponse.json({ ok: true, duplicate: true }); }
    log("error", "stripe_event_claim_failed", { eventId: event.id, eventType: event.type, reason: claim.error.code ?? "unknown" });
    return NextResponse.json({ error: "Could not record event" }, { status: 500 });
  }

  const start = performance.now();
  try {
    const handled = await handleEvent(db, event);
    recordSpan({ traceId, name: `stripe.event.${event.type}`, service: "payments", kind: "consumer", startMs: start, durationMs: performance.now() - start, attrs: { eventId: event.id, eventType: event.type, handled } });
    log("info", "stripe_event_processed", { eventId: event.id, eventType: event.type, handled, durationMs: Math.round(performance.now() - start) });
    return NextResponse.json(handled ? { ok: true } : { ok: true, ignored: event.type });
  } catch (e) {
    recordSpan({ traceId, name: `stripe.event.${event.type}`, service: "payments", kind: "consumer", startMs: start, durationMs: performance.now() - start, status: "error", attrs: { eventId: event.id, eventType: event.type } });
    reportError(e, { route: "webhooks/stripe", severity: "critical", attrs: { eventType: event.type } });
    log("error", "stripe_event_failed", { eventId: event.id, eventType: event.type });
    await db.from("stripe_events").delete().eq("id", event.id); // let Stripe retry
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
}

type Obj = Record<string, unknown> & { id: string };
type StripeEvent = { id: string; type: string; data: { object: Obj } };
type Db = NonNullable<ReturnType<typeof serviceClient>>;

async function requireWrite(result: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await result;
  if (error) throw new Error("stripe_webhook_database_write_failed");
}

const metaRental = (o: Obj) => ((o.metadata as Record<string, string> | undefined)?.rental_id ?? null);
const iso = (unix: unknown) => (typeof unix === "number" ? new Date(unix * 1000).toISOString() : null);
const CLOSED_DISPUTE = new Set(["won", "lost", "warning_closed"]);

/** Emits a customer notification to a rental's registered renter. Best-effort: never throws. */
async function emitToRenter(db: Db, rentalId: string, input: Omit<import("@/lib/notify").EmitInput, "profileId" | "vars"> & { vars?: Record<string, string | number> }) {
  try {
    const { data: r } = await db.from("rentals").select("customer_id,renter_profile,reference").eq("id", rentalId).maybeSingle();
    const row = r as { customer_id: string | null; renter_profile: string | null; reference: string } | null;
    const pid = row?.customer_id ?? row?.renter_profile;
    if (!pid) return;
    const { emit } = await import("@/lib/notify");
    await emit(db, {
      ...input, profileId: pid,
      deepLink: input.deepLink === "auto" ? `rental:${row?.reference ?? ""}` : input.deepLink,
      vars: { rental_ref: row?.reference ?? "", ...(input.vars ?? {}) },
    });
  } catch { /* notification is best-effort; the ledger truth is already recorded */ }
}

async function handleEvent(db: Db, event: StripeEvent): Promise<boolean> {
  const o = event.data.object;
  // Monetization products (membership/gift/package/event pass + subscription lifecycle).
  if (await handleMonetizationEvent(db, event)) return true;
  switch (event.type) {
    case "checkout.session.completed": {
      if ((o.metadata as Record<string, string> | undefined)?.kind === "ad_campaign") {
        return handleAdCheckoutCompleted(db, o);
      }
      const rentalId = metaRental(o);
      const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
      const email = (o.customer_details as { email?: string } | undefined)?.email ?? null;
      const phone = (o.customer_details as { phone?: string } | undefined)?.phone ?? null;
      const tax = (o.total_details as { amount_tax?: number } | undefined)?.amount_tax ?? 0;
      const q = db.from("payments").select("id,rental_id,state").eq("stripe_checkout_session_id", o.id);
      const { data: pay } = await q.maybeSingle();
      const target = pay ?? (rentalId ? (await db.from("payments").select("id,rental_id,state").eq("rental_id", rentalId).maybeSingle()).data : null);
      if (!target) return true;
      const revived = target.state === "failed"; // customer retried inside the same Checkout session
      await requireWrite(db.from("payments").update({
        stripe_checkout_session_id: o.id, stripe_payment_intent_id: piId ?? undefined, tax_cents: tax,
        ...(email ? { receipt_email: email } : {}), ...(phone ? { customer_phone: phone } : {}), ...(revived ? { state: "authorized", failure_code: null } : {}),
      }).eq("id", target.id));
      await requireWrite(db.from("rentals").update({ state: "dispense_pending" }).eq("id", target.rental_id).in("state", revived ? ["authorized", "cancelled"] : ["authorized"]));
      // Payment verified → queue the ONE durable dispense command for this
      // rental (idempotent on `dispense:{rental_id}` — replays are no-ops).
      // Failures are logged, not thrown: runDispenseSweep is the backstop.
      await issueDispenseCommand(db, target.rental_id).catch((e) =>
        recordLog("error", "dispense_command_issue_failed", { service: "payments", route: "webhooks/stripe", attrs: { rentalId: target.rental_id, reason: e instanceof Error ? e.message : "unknown" } }));
      trackServer({ name: "rental_started", entityType: "rental", entityId: target.rental_id });
      // NOTE: checkout phone/email are customer-typed and unverified — never bind them to a profile here.
      return true;
    }
    // Native PaymentSheet path: a manual-capture PI fires amount_capturable_updated
    // once the card is authorized — the exact analogue of checkout.session.completed.
    case "payment_intent.amount_capturable_updated": {
      const kind = (o.metadata as Record<string, string> | undefined)?.kind;
      if (kind === "ad_campaign" || kind === "non_return_fee" || kind === "rental_overage") return true;
      const { data: pay } = await db.from("payments").select("id,rental_id,state").eq("stripe_payment_intent_id", o.id).maybeSingle();
      if (!pay) return true;
      const revived = pay.state === "failed";
      await requireWrite(db.from("payments").update({
        ...(revived ? { state: "authorized", failure_code: null } : {}),
      }).eq("id", pay.id));
      await requireWrite(db.from("rentals").update({ state: "dispense_pending" }).eq("id", pay.rental_id).in("state", revived ? ["authorized", "cancelled"] : ["authorized"]));
      await issueDispenseCommand(db, pay.rental_id).catch((e) =>
        recordLog("error", "dispense_command_issue_failed", { service: "payments", route: "webhooks/stripe", attrs: { rentalId: pay.rental_id, reason: e instanceof Error ? e.message : "unknown" } }));
      trackServer({ name: "rental_started", entityType: "rental", entityId: pay.rental_id });
      return true;
    }
    case "payment_intent.succeeded": {
      const pi = o as Obj & { amount_received?: number; receipt_email?: string; latest_charge?: unknown };
      const kind = (o.metadata as Record<string, string> | undefined)?.kind;
      if (kind === "ad_campaign") return handleAdPaymentIntent(db, o, "succeeded");
      if (kind === "wallet_topup") {
        const { fulfillWalletTopupIntent } = await import("@/lib/wallet-topups");
        await fulfillWalletTopupIntent(db, pi);
        return true;
      }
      if (kind === "non_return_fee") {
        // Separate fee PI: reconcile billing_ledger + rental fee flag. Never touches the payments row.
        const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : null;
        await requireWrite(db.from("billing_ledger").update({ status: "succeeded", ...(chargeId ? { stripe_charge_id: chargeId } : {}) })
          .eq("stripe_payment_intent_id", pi.id).in("status", ["pending", "failed"]));
        const rentalId = metaRental(o);
        if (rentalId) await requireWrite(db.from("rentals").update({ non_return_fee_status: "charged" }).eq("id", rentalId));
        if (rentalId) await emitToRenter(db, rentalId, {
          kind: "rental_fee", actor: "webhook", correlationId: `pi:${pi.id}`, deepLink: "auto",
          vars: { amount: pi.amount_received ?? 0, fee: "non-return" },
          dedupeKey: `fee:${pi.id}`,
        });
        return true;
      }
      await requireWrite(db.from("payments").update({
        state: "captured", amount_captured_cents: pi.amount_received ?? null,
        receipt_email: pi.receipt_email ?? undefined, captured_at: new Date().toISOString(),
      }).eq("stripe_payment_intent_id", pi.id));
      await triggerPaymentReceipt(pi.id);
      return true;
    }
    case "payment_intent.payment_failed": {
      const kind = (o.metadata as Record<string, string> | undefined)?.kind;
      if (kind === "ad_campaign") return handleAdPaymentIntent(db, o, "failed");
      if (kind === "wallet_topup") {
        const { failWalletTopupIntent } = await import("@/lib/wallet-topups");
        await failWalletTopupIntent(db, o);
        return true;
      }
      if (kind === "non_return_fee") {
        // Fee PI declined: mark the ledger attempt failed. The rental's own payment/hold is untouched.
        await requireWrite(db.from("billing_ledger").update({ status: "failed" })
          .eq("stripe_payment_intent_id", o.id).eq("status", "pending"));
        const rentalId = metaRental(o);
        if (rentalId) await requireWrite(db.from("rentals").update({ non_return_fee_status: "failed" }).eq("id", rentalId));
        return true;
      }
      const rentalId = metaRental(o);
      const code = (o.last_payment_error as { code?: string; decline_code?: string } | undefined);
      const { data: byPi } = await db.from("payments").select("id,rental_id").eq("stripe_payment_intent_id", o.id).maybeSingle();
      const pay = byPi ?? (rentalId ? (await db.from("payments").select("id,rental_id").eq("rental_id", rentalId).maybeSingle()).data : null);
      if (!pay) return true;
      await requireWrite(db.from("payments").update({ state: "failed", failure_code: code?.decline_code ?? code?.code ?? "payment_failed", stripe_payment_intent_id: o.id }).eq("id", pay.id).eq("state", "authorized"));
      await requireWrite(db.from("rentals").update({ state: "cancelled" }).eq("id", pay.rental_id).eq("state", "authorized"));
      trackServer({ name: "rental_payment_failed", entityType: "rental", entityId: pay.rental_id, props: { failure_code: code?.decline_code ?? code?.code ?? "payment_failed" } });
      await triggerPaymentFailedHtml(pay.rental_id);
      return true;
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
      if (!piId) return true;
      const { data: pay } = await db.from("payments").select("id,rental_id").eq("stripe_payment_intent_id", piId).maybeSingle();
      // Monetization PIs (gift/package/group/event pass/membership) aren't in
      // `payments` — log + audit the dispute for staff, never auto-act.
      if (!pay) return handleMonetizationDispute(db, o);
      const status = String(o.status ?? "");
      const closed = event.type === "charge.dispute.closed" || CLOSED_DISPUTE.has(status);
      const row: Record<string, unknown> = {
        payment_id: pay.id, stripe_dispute_id: o.id, status, amount_cents: typeof o.amount === "number" ? o.amount : null,
        currency: typeof o.currency === "string" ? o.currency : null, reason: typeof o.reason === "string" ? o.reason : null,
        evidence_due_by: iso((o.evidence_details as { due_by?: number } | undefined)?.due_by),
        ...(closed ? { resolved_at: new Date().toISOString() } : {}),
      };
      const { error } = await db.from("disputes").upsert(row, { onConflict: "stripe_dispute_id" });
      if (error) throw new Error("dispute_upsert_failed");
      if (event.type === "charge.dispute.created") {
        const [{ data: staff }, rental, payDetail] = await Promise.all([
          db.from("profiles").select("email").in("role", ["admin", "staff"]).limit(50),
          pay.rental_id ? db.from("rentals").select("reference").eq("id", pay.rental_id).maybeSingle() : Promise.resolve({ data: null }),
          db.from("payments").select("receipt_email").eq("id", pay.id).maybeSingle(),
        ]);
        if (pay.rental_id) await emitToRenter(db, pay.rental_id, {
          kind: "dispute_opened", actor: "webhook", correlationId: `dispute:${o.id}`, deepLink: "account",
          vars: { amount: typeof o.amount === "number" ? ` of ${fmt(o.amount)}` : "" },
          dedupeKey: `dispute:${o.id}`,
        });
        const fields = {
          disputeId: String(o.id ?? ""),
          amount: typeof o.amount === "number" ? fmt(o.amount) : "unknown",
          rentalRef: (rental.data as { reference?: string } | null)?.reference ?? "—",
          customerEmail: (payDetail.data as { receipt_email?: string } | null)?.receipt_email ?? "—",
          reason: typeof o.reason === "string" ? o.reason : "—",
          openedAt: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
          respondBy: row.evidence_due_by ? new Date(String(row.evidence_due_by)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : undefined,
        };
        for (const s of (staff ?? []) as { email: string }[]) await triggerPaymentDispute(s.email, fields).catch(() => false);
      }
      return true;
    }
    case "charge.refunded": {
      if (await handleAdChargeRefunded(db, o)) return true;
      const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
      if (!piId) return true;
      // Monetization products reconcile by their own rows (gift/package/group/
      // event pass/membership); skip the Stripe PI lookup when it's a rental.
      const { data: rentalPay } = await db.from("payments").select("id,rental_id,state").eq("stripe_payment_intent_id", piId).limit(1).maybeSingle();
      if (!rentalPay && (await handleMonetizationRefund(db, o))) return true;
      // The non-return fee is a separate PI with no payments row — reconcile it
      // against its billing_ledger row or the refund drops silently.
      if (!rentalPay && (await reconcileNonReturnFeeRefund(db, o, piId))) return true;
      const refunded = typeof o.amount_refunded === "number" ? o.amount_refunded : 0;
      const captured = typeof o.amount_captured === "number" ? o.amount_captured : typeof o.amount === "number" ? o.amount : 0;
      await requireWrite(db.from("payments").update({
        amount_refunded_cents: refunded, state: refunded > 0 && refunded >= captured ? "refunded" : "partially_refunded",
      }).eq("stripe_payment_intent_id", piId));
      // Rental payments get ledger delta + credit release + external-refund
      // flagging — Stripe-dashboard refunds no longer bypass reconciliation.
      if (rentalPay) await reconcileRentalPaymentRefund(db, rentalPay as { id: string; rental_id: string; state?: string }, o, piId);
      if (rentalPay?.rental_id && refunded > 0) {
        const card = (o.payment_method_details as { card?: { brand?: string; last4?: string } } | undefined)?.card;
        await emitToRenter(db, rentalPay.rental_id, {
          kind: "refund_issued", actor: "webhook", correlationId: `refund:${piId}:${refunded}`, deepLink: "account",
          vars: {
            amount: refunded,
            card_ref: card?.brand && card?.last4 ? ` to your ${card.brand[0].toUpperCase()}${card.brand.slice(1)} •••• ${card.last4}` : " to your original payment method",
          },
          dedupeKey: `refund:${piId}:${refunded}`,
        });
      }
      return true;
    }
    default:
      return false;
  }
}
