import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { flag } from "@/lib/notifications";
import { triggerRentalReturned, triggerRentalStarted } from "@/lib/email-triggers";
import { auditLog } from "@/lib/audit";
import { applyPromo, holdCents, PRICING_SELECT, pricingFromRow, proportionalTaxCents, rentalChargeCents, type PricingRow } from "@/lib/billing";
import { PRICING_V1 } from "@/lib/pricing";
import { lookupPromo } from "@/lib/promos";
import { cancelPaymentIntent, capturePaymentIntent, PAYMENTS_UNCONFIGURED, stripeConfigured, taxEnabled } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

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
  const done = (state: string, outcome?: CaptureOutcome) => {
    if (req.headers.get("content-type")?.includes("json")) return NextResponse.json({ ok: true, state, ...(outcome ? { payment: outcome } : {}) });
    const url = new URL("/admin/rentals", req.url);
    if (outcome) { url.searchParams.set("result", outcome.status === "error" ? "error" : outcome.status); url.searchParams.set("detail", outcome.detail); }
    return NextResponse.redirect(url, 303);
  };
  const now = new Date();

  if (action === "dispense") {
    const deadline = new Date(now.getTime() + PRICING_V1.nonReturnAfterHours * 3600_000);
    const { error } = await db.from("rentals").update({ state: "active", dispensed_at: now.toISOString(), non_return_deadline: deadline.toISOString() }).eq("id", id).eq("state", "dispense_pending");
    if (error) return NextResponse.json({ error: "Couldn't confirm dispense." }, { status: 500 });
    await triggerRentalStarted(id);
    return done("active");
  }

  if (action === "return") {
    const { data: moved, error } = await db.from("rentals").update({ state: "returned", returned_at: now.toISOString() }).eq("id", id).in("state", ["active", "unreturned"]).select("id");
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

  return NextResponse.json({ error: "action must be dispense, return or nonreturn" }, { status: 400 });
}

type CaptureOutcome = { status: "captured" | "released" | "skipped" | "flagged" | "charged" | "error"; detail: string; cents?: number };

type RentalCtx = {
  id: string; state: string; started_at: string | null; dispensed_at: string | null; returned_at: string | null;
  pricing_version: string; bank_count: number; promo_code: string | null; non_return_deadline: string | null;
  payments: { id: string; state: string; stripe_payment_intent_id: string | null; amount_authorized_cents: number | null; tax_cents: number | null }[];
};

async function loadCtx(db: NonNullable<ReturnType<typeof serviceClient>>, id: string) {
  const { data } = await db.from("rentals").select("id,state,started_at,dispensed_at,returned_at,pricing_version,bank_count,promo_code,non_return_deadline,payments(id,state,stripe_payment_intent_id,amount_authorized_cents,tax_cents)").eq("id", id).maybeSingle();
  return data as unknown as RentalCtx | null;
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
  const gross = rentalChargeCents(start, r.returned_at ?? now, pricing, r.bank_count);
  if (gross === null) {
    await auditLog(actor, "capture_flagged_over_24h", "rental", id, { reason: "additional-day pricing not finalised" });
    return { status: "flagged", detail: "Rental ran past 24 hours and additional-day pricing is not finalised. Not captured; review manually." };
  }
  const promo = r.promo_code ? await lookupPromo(db, r.promo_code) : null;
  const { discountCents, netCents } = applyPromo(gross, promo);
  const tax = taxEnabled() ? proportionalTaxCents(pay.tax_cents ?? 0, holdCents(pricing, r.bank_count), netCents) : 0;
  const total = netCents + tax;

  if (total <= 0) {
    const c = await cancelPaymentIntent(pay.stripe_payment_intent_id, `release_${pay.id}`);
    if (!c.ok) return { status: "error", detail: "Couldn't release the hold." };
    await db.from("payments").update({ state: "released", amount_captured_cents: 0, discount_cents: discountCents, tax_cents: 0 }).eq("id", pay.id);
    await auditLog(actor, "release_hold", "payment", pay.id, { discountCents });
    return { status: "released", detail: "Fully discounted; the hold was released.", cents: 0 };
  }
  const cap = await capturePaymentIntent(pay.stripe_payment_intent_id, total, `capture_${pay.id}`);
  if (!cap.ok) return { status: "error", detail: `Capture failed (${cap.code}). The payment stays authorized.` };
  await db.from("payments").update({ state: "captured", amount_captured_cents: total, discount_cents: discountCents, tax_cents: tax, captured_at: now.toISOString() }).eq("id", pay.id);
  await auditLog(actor, "capture_on_return", "payment", pay.id, { total, discountCents, tax, banks: r.bank_count });
  return { status: "captured", detail: "Charge captured.", cents: total };
}

async function chargeNonReturn(db: NonNullable<ReturnType<typeof serviceClient>>, id: string, now: Date, actor: string): Promise<CaptureOutcome> {
  const r = await loadCtx(db, id);
  const pay = r?.payments?.[0];
  if (!r || !pay) return { status: "error", detail: "Rental or payment not found." };
  const overdue = r.state === "unreturned" || (r.state === "active" && !!r.non_return_deadline && new Date(r.non_return_deadline) <= now);
  if (!overdue) return { status: "error", detail: "Only unreturned rentals past their deadline can be charged off." };
  if (pay.state !== "authorized" || !pay.stripe_payment_intent_id) return { status: "error", detail: "There is no active authorization to capture." };
  const { data: pr } = await db.from("pricing_versions").select(PRICING_SELECT).eq("id", r.pricing_version).maybeSingle();
  if (!pr) return { status: "error", detail: "Pricing version missing." };
  const amount = holdCents(pricingFromRow(pr as PricingRow), r.bank_count);
  const cap = await capturePaymentIntent(pay.stripe_payment_intent_id, amount, `nonreturn_${pay.id}`);
  if (!cap.ok) return { status: "error", detail: `Capture failed (${cap.code}).` };
  await db.from("payments").update({ state: "captured", amount_captured_cents: amount, captured_at: now.toISOString() }).eq("id", pay.id);
  await db.from("rentals").update({ state: "charged_off" }).eq("id", id);
  await auditLog(actor, "charge_non_return", "rental", id, { amount, banks: r.bank_count });
  return { status: "charged", detail: "Non-return charged.", cents: amount };
}
