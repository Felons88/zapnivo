import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { reportError } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { SITE } from "@/lib/site";
import { createAdCheckoutSession, PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { campaignAmountCents, type AdCampaignRow } from "@/lib/ads/billing";
import { getCampaign } from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";

const PAYABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "scheduled"]);
const PAYABLE_PAYMENT = new Set(["unpaid", "failed"]);
const PAYERS = new Set(["owner", "admin"]);

/**
 * POST /api/advertiser/campaigns/[id]/checkout
 * Verifies membership (owner/admin only — members can view but not pay), campaign
 * ownership, payable status, and a server-computed amount, then opens a Stripe
 * Checkout Session. payment_status flips to 'checkout_pending'; the webhook is
 * authoritative for 'paid' — never trust the browser redirect.
 */
export async function POST(_req: Request, ctxParams: { params: Promise<{ id: string }> }) {
  const { id } = await ctxParams.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });
  if (!stripeConfigured()) return NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 });

  const campaign = await getCampaign(db, id);
  if (!campaign || !campaign.advertiser_org_id) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { data: mem } = await db
    .from("advertiser_members")
    .select("role")
    .eq("org_id", campaign.advertiser_org_id)
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!mem) return NextResponse.json({ error: "You don't have access to this campaign." }, { status: 403 });
  if (!PAYERS.has((mem as { role: string }).role)) {
    return NextResponse.json({ error: "Only an org admin or owner can pay for campaigns." }, { status: 403 });
  }
  const rl = rateLimit(`ads-checkout:${user.id}`, 10, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  if (!PAYABLE_STATUSES.has(campaign.status)) {
    return NextResponse.json({ error: `This campaign can't be paid for in its current state (${campaign.status}).` }, { status: 409 });
  }
  if (!PAYABLE_PAYMENT.has(campaign.payment_status)) {
    return NextResponse.json({ error: `Payment status is ${campaign.payment_status}; nothing to pay.` }, { status: 409 });
  }

  // Require at least one submitted/approved creative before taking money.
  const { count: creativeCount } = await db.from("ad_creatives")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", id).in("status", ["submitted", "approved"]);
  if (!creativeCount) return NextResponse.json({ error: "Add and submit a creative before paying.", code: "no_creative" }, { status: 409 });

  // Server-side amount — rate card first, budget fallback; null = no honest price.
  const amount = await campaignAmountCents(db, campaign as unknown as AdCampaignRow).catch((e) => {
    reportError(e, { route: "/api/advertiser/campaigns/[id]/checkout", attrs: { op: "price" } });
    return null;
  });
  if (!amount || amount.amountCents <= 0) {
    return NextResponse.json({ error: "No price is available for this campaign yet — contact us.", code: "pricing_unavailable" }, { status: 422 });
  }

  const { data: org } = await db.from("advertiser_orgs").select("name,contact_email").eq("id", campaign.advertiser_org_id).maybeSingle();
  const orgRow = org as { name?: string; contact_email?: string } | null;
  const email = orgRow?.contact_email ?? user.email;

  const base = SITE.url.replace(/\/$/, "");
  const detail = `${base}/advertiser/campaigns/${id}`;
  const session = await createAdCheckoutSession({
    campaignId: id, orgId: campaign.advertiser_org_id, amountCents: amount.amountCents, email,
    orgName: orgRow?.name ?? "Advertiser", campaignName: campaign.name,
    successUrl: `${detail}?paid=1`, cancelUrl: `${detail}?paid=0`,
  });
  if (!session.ok || !session.data.url) {
    reportError(new Error(`ad_checkout_failed:${session.ok ? "no_url" : session.code}`), { route: "/api/advertiser/campaigns/[id]/checkout" });
    return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 });
  }

  await db.from("advertising_campaigns").update({
    payment_status: "checkout_pending", stripe_checkout_session_id: session.data.id,
  }).eq("id", id).in("payment_status", ["unpaid", "failed", "checkout_pending"]);

  return NextResponse.json({ ok: true, checkout_url: session.data.url, amount_cents: amount.amountCents });
}
