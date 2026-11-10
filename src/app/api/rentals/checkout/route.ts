import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { holdCents, PRICING_SELECT, pricingFromRow, type PricingRow } from "@/lib/billing";
import { lookupPromo, promoUsable, PROMO_CODE_RE, redeemPromo, releasePromo } from "@/lib/promos";
import { likeEscape } from "@/lib/customer";
import { rateLimit } from "@/lib/rate-limit";
import { SITE } from "@/lib/site";
import { createCheckoutSession, PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  station_id: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
  email: z.string().trim().toLowerCase().email().max(200),
  bank_count: z.coerce.number().int().min(1).max(3).default(1),
  promo_code: z.string().trim().regex(PROMO_CODE_RE).optional().or(z.literal("").transform(() => undefined)),
  consent: z.union([z.literal("on"), z.boolean()]).optional().transform((v) => v === true || v === "on"),
  sms_consent: z.union([z.literal("on"), z.boolean()]).optional().transform((v) => v === true || v === "on"),
});

const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/** Creates a rental + payment row and a manual-capture Stripe Checkout Session. Refuses until pricing is approved. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const rl = rateLimit(`checkout:${clientIp(req)}`, 8, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Please check the details you entered.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const { station_id, email, bank_count, promo_code, consent, sms_consent } = parsed.data;
  if (!consent) return NextResponse.json({ error: "Please accept the rental terms to continue.", fields: { consent: ["Rental terms acceptance is required."] } }, { status: 422 });

  const db = serviceClient();
  if (!stripeConfigured() || !db) return NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 });

  // Pricing: only an APPROVED version may be charged, and the rental locks it.
  const { data: pr } = await db.from("pricing_versions").select(PRICING_SELECT).eq("approved", true).order("effective_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (!pr) return NextResponse.json({ error: "Pricing has not been approved yet, so rentals can't be started.", code: "pricing_not_approved" }, { status: 503 });
  const pricing = pricingFromRow(pr as PricingRow);

  // Station must be online, venue published, and have enough ready banks.
  const unavailable = () => NextResponse.json({ error: "This station isn't available right now.", code: "station_unavailable" }, { status: 409 });
  const { data: kiosk } = await db.from("kiosks").select("id,state,venues(id,city,venue_type,published)").eq("station_id", station_id).maybeSingle();
  const venue = (kiosk as unknown as { venues: { id: string; city: string | null; venue_type: string | null; published: boolean } | null } | null)?.venues;
  if (!kiosk || kiosk.state !== "online" || !venue?.published) return unavailable();
  const { count } = await db.from("kiosk_slots").select("slot_number", { count: "exact", head: true }).eq("kiosk_id", kiosk.id).eq("state", "ready");
  if ((count ?? 0) < bank_count) return unavailable();

  // Promo: validate, then reserve a redemption atomically.
  let promoCode: string | null = null;
  if (promo_code) {
    const p = await lookupPromo(db, promo_code);
    if (!p || !promoUsable(p)) return NextResponse.json({ error: "That promo code isn't valid.", fields: { promo_code: ["Invalid or expired code."] } }, { status: 422 });
    const reserved = await redeemPromo(db, promo_code);
    if (!reserved) return NextResponse.json({ error: "That promo code is no longer available.", fields: { promo_code: ["Invalid or expired code."] } }, { status: 422 });
    promoCode = reserved.code;
  }
  const undoPromo = async () => { if (promoCode) await releasePromo(db, promoCode); };

  const user = await getSessionUser().catch(() => null);
  const customerId = user && user.role === "customer" && user.email.toLowerCase() === email && /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null;
  const { count: out } = await db.from("rentals")
    .select("id,payments!inner(receipt_email)", { count: "exact", head: true })
    .in("state", ["active", "dispense_pending", "unreturned", "overdue"]).ilike("payments.receipt_email", likeEscape(email));
  if ((out ?? 0) >= 2) {
    await undoPromo();
    return NextResponse.json({ error: "Limit reached — return your outstanding chargers before renting another.", code: "rental_limit" }, { status: 409 });
  }
  const hold = holdCents(pricing, bank_count);

  const { data: rental, error: rErr } = await db.from("rentals").insert({
    kiosk_id: kiosk.id, state: "authorized", pricing_version: pricing.id, bank_count, promo_code: promoCode, customer_id: customerId, sms_consent: Boolean(sms_consent),
  }).select("id,reference").single();
  if (rErr || !rental) { await undoPromo(); return NextResponse.json({ error: "We couldn't start your rental. Please try again." }, { status: 500 }); }

  // Sponsored charging: if an active sponsor covers this kiosk, record the redemption.
  // The hold is unchanged — the sponsored minutes are discounted at settlement.
  try {
    const { activeSponsorsForKiosk, applySponsorAtCheckout } = await import("@/lib/ads/sponsored");
    const sponsors = await activeSponsorsForKiosk(db, kiosk.id, venue ? { id: venue.id, city: venue.city, venue_type: venue.venue_type } : null);
    if (sponsors.length) {
      await applySponsorAtCheckout(db, {
        campaignId: sponsors[0].id, rentalId: rental.id, customerRef: email,
        kioskId: kiosk.id, venue: venue ? { id: venue.id, city: venue.city, venue_type: venue.venue_type } : null,
      });
    }
  } catch { /* sponsorship must never block a rental */ }

  const { data: pay, error: pErr } = await db.from("payments").insert({
    rental_id: rental.id, state: "authorized", amount_authorized_cents: hold, currency: "usd", receipt_email: email,
  }).select("id").single();
  const rollback = async () => {
    await db.from("rentals").update({ state: "cancelled" }).eq("id", rental.id);
    if (pay) await db.from("payments").update({ state: "failed", failure_code: "checkout_not_created" }).eq("id", pay.id);
    await undoPromo();
  };
  if (pErr || !pay) { await rollback(); return NextResponse.json({ error: "We couldn't start your rental. Please try again." }, { status: 500 }); }

  const base = SITE.url.replace(/\/$/, "");
  const session = await createCheckoutSession({
    rentalId: rental.id, reference: rental.reference, holdCents: hold, email, stationId: station_id, bankCount: bank_count,
    successUrl: `${base}/r/${encodeURIComponent(station_id)}?status=success`, cancelUrl: `${base}/r/${encodeURIComponent(station_id)}?status=cancelled`,
  });
  if (!session.ok || !session.data.url) { await rollback(); return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 }); }

  await db.from("payments").update({ stripe_checkout_session_id: session.data.id }).eq("id", pay.id);
  return NextResponse.json({ rental_reference: rental.reference, checkout_url: session.data.url }, { status: 201 });
}
