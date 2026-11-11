import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createPackageCheckout } from "@/lib/monetization/checkout";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { subUrl } from "@/lib/site";
import { PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ packageId: z.string().trim().min(1).max(80) });

/**
 * POST /api/monetization/package/checkout { packageId }
 * Creates a package_purchases row (status 'pending') FIRST so the webhook can
 * fulfill it by purchase_id, then opens a Stripe Checkout Session. The purchase
 * amount is snapshotted server-side from the package row — client metadata is
 * never trusted. 503 when Stripe isn't configured.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 422 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });
  if (!stripeConfigured()) return NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 });

  const rl = rateLimit(`mon-package-checkout:${user.id}`, 10, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const { data: pkg, error } = await db
    .from("prepaid_packages")
    .select("id,name,description,kind,units,price_cents,validity_days,active")
    .eq("id", parsed.data.packageId).maybeSingle();
  if (error) {
    recordLog("warning", "monetization_package_lookup_failed", { service: "monetization", route: "api/monetization/package/checkout", attrs: { err: error.message.slice(0, 160) } });
    return NextResponse.json({ error: "Package isn't available right now." }, { status: 503 });
  }
  const p = pkg as { id: string; name: string; price_cents: number; active: boolean } | null;
  if (!p) return NextResponse.json({ error: "Package not found." }, { status: 404 });
  if (!p.active) return NextResponse.json({ error: "This package isn't available.", code: "package_inactive" }, { status: 422 });
  if (p.price_cents <= 0) return NextResponse.json({ error: "This package doesn't have a price yet.", code: "pricing_unavailable" }, { status: 422 });

  // Purchase row FIRST — the webhook flips it pending → paid and grants units.
  const { data: purchase, error: insErr } = await db
    .from("package_purchases")
    .insert({ profile_id: user.id, package_id: p.id, status: "pending", amount_cents: p.price_cents })
    .select("id").single();
  if (insErr || !purchase) {
    recordLog("error", "monetization_purchase_insert_failed", { service: "monetization", route: "api/monetization/package/checkout", attrs: { package: p.id, err: insErr?.message?.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't start the purchase. Please try again." }, { status: 503 });
  }
  const purchaseId = (purchase as { id: string }).id;

  const charging = subUrl("customer", "/charging");
  const session = await createPackageCheckout({
    purchaseId, packageId: p.id, packageName: p.name, amountCents: p.price_cents, profileId: user.id,
    email: user.email, successUrl: `${charging}?paid=1`, cancelUrl: `${charging}?paid=0`,
  });
  if (!session.ok || !session.data.url) {
    // Leave the row 'pending' — honest state; a later paid webhook can still fulfill it.
    recordLog("error", "monetization_package_checkout_failed", { service: "monetization", route: "api/monetization/package/checkout", attrs: { purchase: purchaseId, reason: session.ok ? "no_url" : session.code } });
    return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 });
  }

  await db.from("package_purchases").update({ stripe_checkout_session_id: session.data.id }).eq("id", purchaseId);
  recordLog("info", "monetization_package_checkout_started", { service: "monetization", route: "api/monetization/package/checkout", attrs: { purchase: purchaseId, package: p.id } });

  return NextResponse.json({ ok: true, url: session.data.url });
}
