import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { giftPurchaseConfirmation } from "@/lib/email-gifts";
import {
  GIFT_PUBLIC_SELECT, GIFT_VALIDITY_DAYS, generateGiftCode, giftCodeHashFor,
  giftPackageById, giftSalesEnabled, type GiftRow,
} from "@/lib/gifts";
import { clientIp, fail, sameOrigin } from "@/lib/helpdesk/http";
import { createGiftCheckout } from "@/lib/monetization/checkout";
import { balance } from "@/lib/monetization/entitlements";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

/**
 * Gift credits.
 * POST — start a gift purchase: creates a pending_payment gift_credits row (only the
 *   sha256 of the code is stored; the raw code is returned ONCE in this response), then
 *   opens a Stripe Checkout session. Requires GIFT_SALES_ENABLED=1.
 * GET  — the signed-in user's purchased gifts + gifts they redeemed (never code_hash).
 */

const purchaseSchema = z.object({
  packageId: z.string().trim().min(1).max(64),
  recipientEmail: z.string().trim().email().max(320).optional().or(z.literal("")),
  message: z.string().trim().max(500).optional(),
});

const publicGift = (g: GiftRow) => ({
  id: g.id,
  package: g.package,
  value_cents: g.value_cents,
  recipient_email: g.recipient_email,
  message: g.message,
  status: g.status,
  expires_at: g.expires_at,
  redeemed_at: g.redeemed_at,
  refunded_at: g.refunded_at,
  created_at: g.created_at,
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  const db = serviceClient();
  if (!db) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });

  // Purchased: matched by profile id OR account email (covers gifts bought before sign-in linking).
  const purchasedQ = db.from("gift_credits").select(GIFT_PUBLIC_SELECT)
    .or(`purchaser_profile.eq.${user.id},purchaser_email.eq.${user.email}`)
    .order("created_at", { ascending: false }).limit(100);
  const redeemedQ = db.from("gift_credits").select(GIFT_PUBLIC_SELECT)
    .eq("redeemed_by", user.id).order("redeemed_at", { ascending: false }).limit(100);
  const [purchased, redeemed, bal] = await Promise.all([purchasedQ, redeemedQ, balance(db, user.id, "cent")]);
  if (purchased.error || redeemed.error) {
    recordLog("warning", "gift_list_failed", { service: "gifts", attrs: { err: (purchased.error ?? redeemed.error)?.message.slice(0, 120) } });
    return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });
  }
  return NextResponse.json({
    purchased: ((purchased.data ?? []) as GiftRow[]).map(publicGift),
    redeemed: ((redeemed.data ?? []) as GiftRow[]).map(publicGift),
    credit_balance_cents: bal?.cent ?? 0,
    sales_enabled: giftSalesEnabled(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  if (!rateLimit(`gift-purchase:${user.id}:${clientIp(req)}`, 10, 60 * 60_000).ok) {
    return fail(429, "Too many gift purchases. Please try again later.");
  }
  if (!giftSalesEnabled()) {
    return fail(503, "Gift purchases aren't open yet.", { code: "gift_sales_disabled" });
  }
  const parsed = purchaseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Check the package and recipient details.");
  const pkg = giftPackageById(parsed.data.packageId);
  if (!pkg) return fail(422, "Unknown gift package.");

  const db = serviceClient();
  if (!db) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });

  const code = generateGiftCode();
  const expiresAt = new Date(Date.now() + GIFT_VALIDITY_DAYS * 86400_000).toISOString();
  const recipient = parsed.data.recipientEmail?.trim() || null;
  const message = parsed.data.message?.trim() || null;

  const { data: gift, error: insErr } = await db.from("gift_credits").insert({
    code_hash: giftCodeHashFor(code),
    purchaser_email: user.email,
    purchaser_profile: user.id,
    package: pkg.label,
    value_cents: pkg.creditCents,
    recipient_email: recipient,
    message,
    status: "pending_payment",
    expires_at: expiresAt,
  }).select("id").single();
  if (insErr || !gift) {
    recordLog("warning", "gift_create_failed", { service: "gifts", attrs: { err: insErr?.message.slice(0, 160) } });
    return fail(503, "We couldn't start that purchase. Please try again.");
  }
  const giftId = (gift as { id: string }).id;

  const origin = new URL(req.url).origin;
  const checkout = await createGiftCheckout({
    giftId,
    packageLabel: pkg.label,
    amountCents: pkg.priceCents,
    email: user.email,
    successUrl: `${origin}/account/gifts?purchase=success`,
    cancelUrl: `${origin}/account/gifts?purchase=cancelled`,
  });
  if (!checkout.ok || !checkout.data?.url) {
    recordLog("warning", "gift_checkout_failed", { service: "gifts", attrs: { gift: giftId.slice(0, 8), err: checkout.ok ? "no_url" : checkout.code } });
    // Leave the row pending_payment; it expires unpaid and can be cleaned up by staff.
    return fail(503, "Payments aren't available right now. Please try again later.", { code: checkout.ok ? "checkout_failed" : checkout.code });
  }
  await db.from("gift_credits").update({ stripe_checkout_session_id: checkout.data.id }).eq("id", giftId);

  // Honest "purchase initiated" email — no code inside; the code was already shown once in this response.
  void giftPurchaseConfirmation(user.email, pkg.label, pkg.creditCents, recipient).catch(() => undefined);

  recordLog("info", "gift_checkout_created", { service: "gifts", attrs: { gift: giftId.slice(0, 8), package: pkg.id } });
  return NextResponse.json({
    ok: true,
    url: checkout.data.url,
    // One-time display of the redemption code. Never stored or logged in raw form.
    code,
    expires_at: expiresAt,
    note: "Save this code now — it is shown only once. It becomes redeemable after payment completes.",
  });
}
