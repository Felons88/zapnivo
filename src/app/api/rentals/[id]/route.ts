import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { flag } from "@/lib/notifications";
import { triggerRentalReturned, triggerRentalStarted } from "@/lib/email-triggers";
import { auditLog } from "@/lib/audit";
import { applyPromo, holdCents, PRICING_SELECT, pricingFromRow, proportionalTaxCents, rentalChargeCents, type PricingRow } from "@/lib/billing";
import { lookupPromo } from "@/lib/promos";
import { nonReturnDeadlineIso } from "@/lib/payments/nonreturn-deadline";
import { cancelPaymentIntent, capturePaymentIntent, createOffSessionPaymentIntent, PAYMENTS_UNCONFIGURED, retrievePaymentIntent, stripeConfigured, taxEnabled } from "@/lib/stripe";
import { chargeNonReturnFee } from "@/lib/payments/nonreturn";
import { notifyFeeCharged, queueJob } from "@/lib/notifications";
import { pushToRentalCustomer } from "@/lib/push";
import { sendToCustomer } from "@/lib/email-triggers";
import { appendLedger } from "@/lib/payments/ledger";
import { sponsoredDiscountCents, recordSponsorSpend } from "@/lib/ads/sponsored";
import { serviceClient } from "@/lib/supabase";
import { fmt } from "@/lib/pricing";

/** Staff rental lifecycle actions. Dispense/return confirmations fire the branded customer emails. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;
  const form = req.headers.get("content-type")?.includes("json")
    ? await req.json().catch(() => ({}))
    : Object.fromEntries(await req.formData());
  const action = String((form as { action?: string }).action ?? "");
  // Optional same-origin path to return to after the action (e.g. a customer 360 page).
  const backTo = (() => { const b = (form as { back?: string }).back; return b && /^\/[A-Za-z0-9/_%@-]+$/.test(b) && !b.startsWith("//") ? b : "/admin/rentals"; })();
  const done = (state: string, outcome?: CaptureOutcome) => {
    if (req.headers.get("content-type")?.includes("json")) return NextResponse.json({ ok: true, state, ...(outcome ? { payment: outcome } : {}) });
    const url = new URL(backTo, req.url);
    if (outcome) { url.searchParams.set("result", outcome.status === "error" ? "error" : outcome.status); url.searchParams.set("detail", outcome.detail); }
    return NextResponse.redirect(url, 303);
  };
  const now = new Date();

  if (action === "dispense") {
    // Deadline hours come from the rental's LOCKED pricing_versions row
    // (non_return_after_hours), shared with the kiosk dispense-ack path.
    const deadline = await nonReturnDeadlineIso(db, id, now);
    const { error } = await db.from("rentals").update({ state: "active", dispensed_at: now.toISOString(), non_return_deadline: deadline }).eq("id", id).eq("state", "dispense_pending");
    if (error) return NextResponse.json({ error: "Couldn't confirm dispense." }, { status: 500 });
    await triggerRentalStarted(id);
    return done("active");
  }

  if (action === "return") {
    // Fold an open pause window into paused_seconds so the clock math stays honest
    // and the row doesn't sit "paused" after it's returned.
    const rr = await loadCtx(db, id);
    const pauseDelta = rr?.paused_at ? Math.max(0, Math.round((now.getTime() - new Date(rr.paused_at).getTime()) / 1000)) : 0;
    const { data: moved, error } = await db.from("rentals").update({ state: "returned", returned_at: now.toISOString(), paused_at: null, ...(pauseDelta ? { paused_seconds: (rr?.paused_seconds ?? 0) + pauseDelta } : {}) }).eq("id", id).in("state", RETURNABLE_STATES).select("id");
    if (error) return NextResponse.json({ error: "Couldn't record the return." }, { status: 500 });
    let capture: CaptureOutcome = { status: "skipped", detail: "Rental was not active, so nothing was captured." };
    if (moved && moved.length > 0) capture = await captureOnReturn(db, id, now, user!.id);
    await triggerRentalReturned(id);
    return done("returned", capture);
  }

  if (action === "nonreturn") {
    if (!(await flag(db, "non_return_billing_enabled"))) return NextResponse.json({ error: "Non-return billing is disabled by the kill switch." }, { status: 503 });
    // Moves funds: admin only, explicit confirmation, never automatic.
    if (user!.role !== "admin") return NextResponse.json({ error: "Only an admin can charge off a rental." }, { status: 403 });
    if ((form as { confirm?: string }).confirm !== "yes") return done("unchanged", { status: "error", detail: "Tick the confirmation box to charge a non-return." });
    if (!stripeConfigured()) return NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 });
    const out = await chargeNonReturn(db, id, now, user!.id);
    return done(out.status === "charged" ? "charged_off" : "unchanged", out);
  }

  /* ── Support-side adjustments: pause the billing clock, resume it, extend the deadline.
     Every one notifies the customer (email + transactional SMS) and writes an audit row. ── */

  if (action === "pause") {
    const { data: moved } = await db.from("rentals").update({ paused_at: now.toISOString() }).eq("id", id).in("state", RETURNABLE_STATES).is("paused_at", null).select("id,reference");
    if (!moved?.length) return done("unchanged", { status: "error", detail: "Only a rental with the bank still out — and not already paused — can be paused." });
    await auditLog(user!.id, "rental_paused", "rental", id);
    const note = await notifyAdjustment(db, id, "paused");
    return done("paused", { status: "info", detail: `Rental paused — the billing clock is stopped.${note}` });
  }

  if (action === "resume") {
    const r = await loadCtx(db, id);
    if (!r?.paused_at) return done("unchanged", { status: "error", detail: "This rental isn't paused." });
    const deltaSec = Math.max(0, Math.round((now.getTime() - new Date(r.paused_at).getTime()) / 1000));
    const newDeadline = r.non_return_deadline ? new Date(new Date(r.non_return_deadline).getTime() + deltaSec * 1000).toISOString() : null;
    const { data: moved } = await db.from("rentals").update({ paused_at: null, paused_seconds: (r.paused_seconds ?? 0) + deltaSec, non_return_deadline: newDeadline }).eq("id", id).not("paused_at", "is", null).select("id");
    if (!moved?.length) return done("unchanged", { status: "error", detail: "This rental isn't paused." });
    await auditLog(user!.id, "rental_resumed", "rental", id, { paused_seconds_added: deltaSec });
    const note = await notifyAdjustment(db, id, "resumed");
    return done("active", { status: "info", detail: `Rental resumed — ${Math.round(deltaSec / 60)} min of paused time added to the deadline.${note}` });
  }

  if (action === "extend") {
    const hours = Math.round(Number((form as { hours?: string }).hours));
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return done("unchanged", { status: "error", detail: "Choose between 1 and 168 extra hours." });
    const r = await loadCtx(db, id);
    if (!r || !OPEN_STATES.includes(r.state)) return done("unchanged", { status: "error", detail: "Only an open rental can be extended." });
    const base = r.non_return_deadline && new Date(r.non_return_deadline) > now ? new Date(r.non_return_deadline) : now;
    const newDeadline = new Date(base.getTime() + hours * 3_600_000).toISOString();
    const { error } = await db.from("rentals").update({ non_return_deadline: newDeadline }).eq("id", id);
    if (error) return NextResponse.json({ error: "Couldn't extend the deadline." }, { status: 500 });
    await auditLog(user!.id, "rental_extended", "rental", id, { hours, new_deadline: newDeadline });
    const note = await notifyAdjustment(db, id, "extended");
    return done("extended", { status: "info", detail: `Added ${hours}h — new return deadline ${new Date(newDeadline).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.${note}` });
  }

  return NextResponse.json({ error: "action must be dispense, return, nonreturn, pause, resume or extend" }, { status: 400 });
}

type CaptureOutcome = { status: "captured" | "released" | "skipped" | "flagged" | "charged" | "info" | "error"; detail: string; cents?: number };

/** Bank is physically out — the same set the kiosk return path accepts. */
const RETURNABLE_STATES = ["active", "return_pending", "overdue", "unreturned"];
/** Any non-terminal rental a staff member can still act on. */
const OPEN_STATES = ["authorized", "payment_authorized", "dispense_pending", "active", "return_pending", "overdue", "unreturned", "non_return_fee_pending", "disputed"];

type RentalCtx = {
  id: string; reference: string; state: string; customer_id: string | null; started_at: string | null; dispensed_at: string | null; returned_at: string | null;
  paused_at: string | null; paused_seconds: number | null;
  pricing_version: string; bank_count: number; promo_code: string | null; non_return_deadline: string | null; non_return_fee_status: string | null;
  payments: { id: string; state: string; stripe_payment_intent_id: string | null; amount_authorized_cents: number | null; tax_cents: number | null; receipt_email: string | null }[];
};

async function loadCtx(db: NonNullable<ReturnType<typeof serviceClient>>, id: string) {
  const { data } = await db.from("rentals").select("id,reference,state,customer_id,started_at,dispensed_at,returned_at,paused_at,paused_seconds,pricing_version,bank_count,promo_code,non_return_deadline,non_return_fee_status,payments(id,state,stripe_payment_intent_id,amount_authorized_cents,tax_cents,receipt_email)").eq("id", id).maybeSingle();
  return data as unknown as RentalCtx | null;
}

/** Total paused milliseconds for a rental as of `at`, including an open pause window. */
const pausedMs = (r: Pick<RentalCtx, "paused_at" | "paused_seconds">, at: Date) =>
  (r.paused_seconds ?? 0) * 1000 + (r.paused_at ? Math.max(0, at.getTime() - new Date(r.paused_at).getTime()) : 0);

/**
 * Customer notification for a staff adjustment — queues the transactional SMS job
 * (rental_paused/resumed/extended/credit_granted) and emails the receipt address.
 * Returns a short suffix for the staff-facing result message.
 */
async function notifyAdjustment(db: NonNullable<ReturnType<typeof serviceClient>>, id: string, kind: "paused" | "resumed" | "extended"): Promise<string> {
  const r = await loadCtx(db, id);
  if (!r) return "";
  // notification_jobs dedupes forever on (rental_id, kind) — clear the previous
  // job's row (unless mid-send) so a second pause/extend still texts the customer.
  try {
    await db.from("notification_jobs").delete().eq("rental_id", id).eq("kind", `rental_${kind}`).neq("status", "sending");
    await queueJob(db, { kind: `rental_${kind}`, rentalId: id });
  } catch { /* SMS queue is best-effort */ }
  const email = r.payments?.[0]?.receipt_email;
  if (!email) return " No receipt email on file — customer notified by SMS only.";
  const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const copy = {
    paused: { subject: `Your Zapnivo rental ${r.reference} is paused`, body: `We've paused the hourly clock on rental ${r.reference}. No hourly charges accrue while it's paused. When you're done, return the power bank to any Zapnivo station — or reply to support and we'll resume it.` },
    resumed: { subject: `Your Zapnivo rental ${r.reference} resumed`, body: `Rental ${r.reference} is running again — the hourly clock restarted and your return deadline moved to ${stamp(r.non_return_deadline)}. Return the power bank to any Zapnivo station.` },
    extended: { subject: `Extra time on your Zapnivo rental ${r.reference}`, body: `We added time to rental ${r.reference}. Your new return deadline is ${stamp(r.non_return_deadline)}. Return the power bank to any Zapnivo station to end the rental.` },
  }[kind];
  try { await sendToCustomer(email, copy.subject, copy.body, null, null, { sender: "support" }); return " Customer notified by email + SMS."; }
  catch { return " Customer notification could not be delivered — check the outbox."; }
}

/** Captures the real charge (hold remainder releases). Honest no-ops when Stripe/payment isn't ready; never past 24h. */
async function captureOnReturn(db: NonNullable<ReturnType<typeof serviceClient>>, id: string, now: Date, actor: string): Promise<CaptureOutcome> {
  const r = await loadCtx(db, id);
  const pay = r?.payments?.[0];
  if (!r || !pay || pay.state !== "authorized" || !pay.stripe_payment_intent_id) return { status: "skipped", detail: "No authorized payment to capture." };
  if (!stripeConfigured()) return { status: "skipped", detail: "Stripe is not configured; the payment stays authorized." };

  const { data: pr } = await db.from("pricing_versions").select(PRICING_SELECT).eq("id", r.pricing_version).maybeSingle();
  const start = r.started_at ?? r.dispensed_at;
  if (!pr || !start) return { status: "flagged", detail: "Missing pricing or start time; capture manually." };
  const pricing = pricingFromRow(pr as PricingRow);
  // Paused time is never billed: the chargeable period ends earlier by the total pause.
  const chargeEnd = new Date(new Date(r.returned_at ?? now).getTime() - pausedMs(r, new Date(r.returned_at ?? now)));
  const gross = rentalChargeCents(start, chargeEnd, pricing, r.bank_count);
  if (gross === null) {
    await auditLog(actor, "capture_flagged_over_24h", "rental", id, { reason: "additional-day pricing not finalised" });
    return { status: "flagged", detail: "Rental ran past 24 hours and additional-day pricing is not finalised. Not captured; review manually." };
  }
  const promo = r.promo_code ? await lookupPromo(db, r.promo_code) : null;
  const { discountCents: promoDiscount, netCents: afterPromo } = applyPromo(gross, promo);

  // Sponsored charging: discount the sponsor-funded minutes from what the customer pays.
  let sponsorDiscount = 0;
  let sponsorCampaignId: string | null = null;
  try {
    const { data: red } = await db.from("sponsored_redemptions")
      .select("id,campaign_id,minutes_covered,status").eq("rental_id", id).eq("status", "applied").maybeSingle();
    if (red) {
      const rr = red as { id: string; campaign_id: string; minutes_covered: number };
      const elapsedMin = Math.max(0, (chargeEnd.getTime() - new Date(start).getTime()) / 60000);
      sponsorDiscount = sponsoredDiscountCents({
        elapsedMinutes: elapsedMin, minutesCovered: rr.minutes_covered, bankCount: r.bank_count,
        pricing, capCents: afterPromo,
      });
      if (sponsorDiscount > 0) sponsorCampaignId = rr.campaign_id;
    }
  } catch { /* sponsored discount is best-effort; never block settlement */ }

  const discountCents = promoDiscount + sponsorDiscount;
  const netCents = afterPromo - sponsorDiscount;
  const tax = taxEnabled() ? proportionalTaxCents(pay.tax_cents ?? 0, holdCents(pricing, r.bank_count), netCents) : 0;
  const total = netCents + tax;

  // Entitlement credits: commit reserved units against the final charge,
  // release the remainder. Applied credits reduce what Stripe captures.
  let creditApplied = 0;
  try {
    const { applyCreditsAtSettlement } = await import("@/lib/monetization/credits");
    creditApplied = await applyCreditsAtSettlement(db, id, r.customer_id, total, pricing, actor);
  } catch (e) {
    await auditLog(actor, "credit_settlement_error", "rental", id, { err: e instanceof Error ? e.message.slice(0, 140) : "unknown" });
  }
  const chargeTotal = total - creditApplied;

  if (chargeTotal <= 0) {
    const c = await cancelPaymentIntent(pay.stripe_payment_intent_id, `release_${pay.id}`);
    if (!c.ok) return { status: "error", detail: "Couldn't release the hold." };
    await db.from("payments").update({ state: "released", amount_captured_cents: 0, discount_cents: discountCents, tax_cents: 0, credit_cents: creditApplied }).eq("id", pay.id);
    await appendLedger(db, { rentalId: id, kind: "rental_charge", amountCents: 0, stripePaymentIntentId: pay.stripe_payment_intent_id, status: "succeeded", idempotencyKey: `release:${pay.id}`, metadata: { discount_cents: discountCents, sponsor_discount_cents: sponsorDiscount, credit_cents: creditApplied, reason: "hold_released_fully_discounted" } });
    if (sponsorCampaignId && sponsorDiscount > 0) await recordSponsorSpend(db, sponsorCampaignId, sponsorDiscount).catch(() => undefined);
    await auditLog(actor, "release_hold", "payment", pay.id, { discountCents, creditApplied });
    return { status: "released", detail: creditApplied > 0 ? "Fully covered by credits; the hold was released." : "Fully discounted; the hold was released.", cents: 0 };
  }
  // The $12 hold caps what Stripe can capture. Anything above the authorized
  // amount bills off-session on the saved card — the same pattern as the
  // non-return fee — so rentals longer than the hold covers still settle
  // instead of failing capture.
  const authorized = holdCents(pricing, r.bank_count);
  const captureNow = Math.min(chargeTotal, authorized);
  const remainder = chargeTotal - captureNow;
  const cap = await capturePaymentIntent(pay.stripe_payment_intent_id, captureNow, `capture_${pay.id}`);
  if (!cap.ok) return { status: "error", detail: `Capture failed (${cap.code}). The payment stays authorized.` };
  await appendLedger(db, { rentalId: id, kind: "rental_charge", amountCents: captureNow, stripePaymentIntentId: pay.stripe_payment_intent_id, status: "succeeded", idempotencyKey: `capture:${pay.id}`, metadata: { discount_cents: discountCents, sponsor_discount_cents: sponsorDiscount, credit_cents: creditApplied, tax_cents: tax, bank_count: r.bank_count } });

  let overageCents = 0;
  if (remainder > 0) {
    const hold = await retrievePaymentIntent(pay.stripe_payment_intent_id);
    const holdData = hold.ok ? hold.data : null;
    const pm = holdData?.payment_method ?? null;
    let overagePi: string | null = null;
    if (pm) {
      const oc = await createOffSessionPaymentIntent({
        amountCents: remainder, paymentMethodId: pm, customerId: holdData?.customer ?? null,
        rentalId: id, kind: "rental_overage",
        description: `Zapnivo rental overage${r.reference ? ` — rental ${r.reference}` : ""}`,
        idempotencyKey: `overage:${pay.id}`,
      });
      if (oc.ok) {
        overagePi = oc.data.id;
        if (oc.data.status === "succeeded") overageCents = remainder;
      }
    }
    await appendLedger(db, {
      rentalId: id, kind: "rental_overage", amountCents: remainder, stripePaymentIntentId: overagePi,
      status: overageCents === remainder ? "succeeded" : "failed", idempotencyKey: `overage:${pay.id}`,
      metadata: { reason: !pm ? "no_saved_payment_method" : overageCents === remainder ? "captured_off_session" : "off_session_failed" },
    });
    if (overageCents !== remainder) {
      await auditLog(actor, "rental_overage_failed", "rental", id, { remainder, reason: !pm ? "no_saved_payment_method" : "off_session_failed" });
    }
  }

  const billedCents = captureNow + overageCents;
  await db.from("payments").update({ state: "captured", amount_captured_cents: billedCents, discount_cents: discountCents, tax_cents: tax, credit_cents: creditApplied, captured_at: now.toISOString() }).eq("id", pay.id);
  if (sponsorCampaignId && sponsorDiscount > 0) await recordSponsorSpend(db, sponsorCampaignId, sponsorDiscount).catch(() => undefined);
  await auditLog(actor, "capture_on_return", "payment", pay.id, { total, chargeTotal, captureNow, overageCents, discountCents, sponsorDiscount, creditApplied, tax, banks: r.bank_count });
  // Instant charge confirmation — same channel as the other rental pushes.
  if (await flag(db, "push_enabled")) {
    const credited = creditApplied > 0 ? ` (${fmt(creditApplied)} covered by credits)` : "";
    void pushToRentalCustomer(id, { title: `${fmt(billedCents)} charged for ${r.reference}`, body: `Your rental is settled${credited}. Thanks for returning on time — see your receipt in the app.`, data: { type: "rental", reference: r.reference } }).catch(() => 0);
  }
  const detail = remainder > 0
    ? (overageCents === remainder ? `Charge captured — ${fmt(remainder)} above the hold billed to the saved card.` : `Hold captured; ${fmt(remainder)} overage could not be billed off-session — needs review.`)
    : (creditApplied > 0 ? `Charge captured (${fmt(creditApplied)} covered by credits).` : "Charge captured.");
  return { status: "captured", detail, cents: billedCents };
}

/**
 * Non-return = the confirmed flat fee (pricing.nonReturnMaxCents, $45) as a SEPARATE off-session
 * PaymentIntent on the saved card — never a capture of the hold, and never past-24h rental math.
 * On success the original hold is released; on failure the rental stays chargeable for a retry.
 */
async function chargeNonReturn(db: NonNullable<ReturnType<typeof serviceClient>>, id: string, now: Date, actor: string): Promise<CaptureOutcome> {
  const r = await loadCtx(db, id);
  const pay = r?.payments?.[0];
  if (!r || !pay) return { status: "error", detail: "Rental or payment not found." };
  const overdue = ["unreturned", "overdue"].includes(r.state) || (["active", "return_pending"].includes(r.state) && !!r.non_return_deadline && new Date(r.non_return_deadline) <= now);
  if (!overdue) return { status: "error", detail: "Only unreturned rentals past their deadline can be charged off." };
  if (r.non_return_fee_status === "charged") return { status: "error", detail: "The non-return fee was already charged." };
  if (!pay.stripe_payment_intent_id) return { status: "error", detail: "There is no payment on file to charge." };
  const { data: pr } = await db.from("pricing_versions").select(PRICING_SELECT).eq("id", r.pricing_version).maybeSingle();
  if (!pr) return { status: "error", detail: "Pricing version missing." };
  const fee = pricingFromRow(pr as PricingRow).nonReturnMaxCents;

  const out = await chargeNonReturnFee(db, { rentalId: id, reference: r.reference, holdPaymentIntentId: pay.stripe_payment_intent_id, feeCents: fee, actor });
  if (out.status !== "charged") {
    return { status: out.status === "skipped" ? "skipped" : "error", detail: out.detail };
  }
  // Fee collected: release the original hold — post-24h rental charges are never auto-captured.
  await cancelPaymentIntent(pay.stripe_payment_intent_id, `release_${pay.id}`);
  await db.from("rentals").update({ state: "charged_off" }).eq("id", id);
  try { await notifyFeeCharged(id, db); } catch { /* queued notice must not fail the charge */ }
  return { status: "charged", detail: "Non-return fee charged; the card hold was released.", cents: out.cents };
}
