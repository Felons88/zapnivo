import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createMembershipCheckout, createSubscriptionCheckout } from "@/lib/monetization/checkout";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { subUrl } from "@/lib/site";
import { PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ planId: z.string().trim().min(1).max(80) });

/**
 * POST /api/monetization/membership/checkout { planId }
 * Starts a Stripe Checkout Session for an active membership plan. Creates NO
 * membership row — the webhook (checkout.session.completed, kind
 * 'membership' | 'membership_subscription') is authoritative. Prices always come
 * from the membership_plans row, never the client.
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

  const rl = rateLimit(`mon-membership-checkout:${user.id}`, 10, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const { data: plan, error } = await db
    .from("membership_plans")
    .select("id,name,description,price_cents,interval,benefit,active")
    .eq("id", parsed.data.planId).maybeSingle();
  if (error) {
    recordLog("warning", "monetization_plan_lookup_failed", { service: "monetization", route: "api/monetization/membership/checkout", attrs: { err: error.message.slice(0, 160) } });
    return NextResponse.json({ error: "Plan isn't available right now." }, { status: 503 });
  }
  const p = plan as { id: string; name: string; description: string | null; price_cents: number; interval: string; benefit: unknown; active: boolean } | null;
  if (!p) return NextResponse.json({ error: "Plan not found." }, { status: 404 });
  if (!p.active) return NextResponse.json({ error: "This plan isn't available.", code: "plan_inactive" }, { status: 422 });
  if (p.price_cents <= 0) return NextResponse.json({ error: "This plan doesn't have a price yet.", code: "pricing_unavailable" }, { status: 422 });

  const base = {
    email: user.email,
    successUrl: `${subUrl("customer", "/charging")}?paid=1`,
    cancelUrl: `${subUrl("customer", "/charging")}?paid=0`,
    planId: p.id, planName: p.name, amountCents: p.price_cents, profileId: user.id,
  };
  const session = p.interval === "one_time"
    ? await createMembershipCheckout(base)
    : await createSubscriptionCheckout({ ...base, interval: p.interval === "year" ? "year" : "month" });

  if (!session.ok || !session.data.url) {
    recordLog("error", "monetization_checkout_failed", {
      service: "monetization", route: "api/monetization/membership/checkout",
      attrs: { plan: p.id, reason: session.ok ? "no_url" : session.code },
    });
    return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 });
  }
  recordLog("info", "monetization_checkout_started", { service: "monetization", route: "api/monetization/membership/checkout", attrs: { plan: p.id, interval: p.interval } });

  // Activation email is sent by the webhook once payment clears (sendMembershipActivated
  // in src/lib/email-monetization.ts) — nothing is emailed before money moves.
  return NextResponse.json({ ok: true, url: session.data.url });
}
