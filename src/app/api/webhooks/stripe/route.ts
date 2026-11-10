import { NextResponse } from "next/server";
import { triggerPaymentReceipt } from "@/lib/email-triggers";
import { triggerPaymentDispute, triggerPaymentFailedHtml } from "@/lib/email-extra-triggers";
import { fmt } from "@/lib/pricing";
import { verifyStripeSignature } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";
import { trackServer } from "@/lib/analytics";

/** Stripe webhook — verifies the signature (no SDK) and fires the payment_receipt email on success. */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhooks not configured" }, { status: 503 });
  const payload = await req.text();
  const check = verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret);
  if (!check.ok) return NextResponse.json({ error: "Bad signature" }, { status: 400 });

  let event: StripeEvent;
  try { event = JSON.parse(payload) as StripeEvent; } catch { return NextResponse.json({ error: "Bad payload" }, { status: 400 }); }
  if (!event?.id || !event.type || !event.data?.object) return NextResponse.json({ error: "Bad payload" }, { status: 400 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  // Dedupe: the primary key rejects a replayed event id.
  const claim = await db.from("stripe_events").insert({ id: event.id, type: event.type });
  if (claim.error) {
    if (claim.error.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
    return NextResponse.json({ error: "Could not record event" }, { status: 500 });
  }

  try {
    const handled = await handleEvent(db, event);
    return NextResponse.json(handled ? { ok: true } : { ok: true, ignored: event.type });
  } catch {
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

async function handleEvent(db: Db, event: StripeEvent): Promise<boolean> {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
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
      trackServer({ name: "rental_started", entityType: "rental", entityId: target.rental_id });
      // NOTE: checkout phone/email are customer-typed and unverified — never bind them to a profile here.
      return true;
    }
    case "payment_intent.succeeded": {
      const pi = o as Obj & { amount_received?: number; receipt_email?: string; latest_charge?: unknown };
      const kind = (o.metadata as Record<string, string> | undefined)?.kind;
      if (kind === "non_return_fee") {
        // Separate fee PI: reconcile billing_ledger + rental fee flag. Never touches the payments row.
        const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : null;
        await requireWrite(db.from("billing_ledger").update({ status: "succeeded", ...(chargeId ? { stripe_charge_id: chargeId } : {}) })
          .eq("stripe_payment_intent_id", pi.id).in("status", ["pending", "failed"]));
        const rentalId = metaRental(o);
        if (rentalId) await requireWrite(db.from("rentals").update({ non_return_fee_status: "charged" }).eq("id", rentalId));
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
    case "charge.dispute.closed": {
      const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
      if (!piId) return true;
      const { data: pay } = await db.from("payments").select("id,rental_id").eq("stripe_payment_intent_id", piId).maybeSingle();
      if (!pay) return true;
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
      const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
      if (!piId) return true;
      const refunded = typeof o.amount_refunded === "number" ? o.amount_refunded : 0;
      const captured = typeof o.amount_captured === "number" ? o.amount_captured : typeof o.amount === "number" ? o.amount : 0;
      await requireWrite(db.from("payments").update({
        amount_refunded_cents: refunded, state: refunded > 0 && refunded >= captured ? "refunded" : "partially_refunded",
      }).eq("stripe_payment_intent_id", piId));
      return true;
    }
    default:
      return false;
  }
}
