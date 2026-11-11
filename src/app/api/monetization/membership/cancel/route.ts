import { NextResponse } from "next/server";
import { sendMembershipCancelled } from "@/lib/email-monetization";
import { activeMembership } from "@/lib/monetization/entitlements";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { stripeCall, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";

/**
 * POST /api/monetization/membership/cancel
 * Cancels the signed-in customer's active membership.
 *  - Stripe subscription → cancel_at_period_end via Stripe API; benefits continue
 *    to the period end and the webhook reconciles status.
 *  - One-time membership → status 'cancelled' only. Benefits already granted
 *    expire naturally via entitlement_grants.expires_at; NO refund is issued.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const rl = rateLimit(`mon-membership-cancel:${user.id}`, 6, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const mem = await activeMembership(db, user.id);
  if (!mem) return NextResponse.json({ error: "No active membership.", code: "no_membership" }, { status: 404 });

  const { data: full } = await db
    .from("customer_memberships")
    .select("id,plan_id,status,stripe_subscription_id,current_period_end")
    .eq("id", mem.id).maybeSingle();
  const row = full as { id: string; plan_id: string; status: string; stripe_subscription_id: string | null; current_period_end: string | null } | null;
  if (!row) return NextResponse.json({ error: "No active membership.", code: "no_membership" }, { status: 404 });

  const { data: plan } = await db.from("membership_plans").select("name").eq("id", row.plan_id).maybeSingle();
  const planName = (plan as { name?: string } | null)?.name ?? null;

  if (row.stripe_subscription_id) {
    if (!stripeConfigured()) return NextResponse.json({ error: "Payments are not available yet.", code: "payments_unconfigured" }, { status: 503 });
    const res = await stripeCall<{ id: string; cancel_at_period_end?: boolean }>(
      "POST", `/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
      { cancel_at_period_end: true }, `memcancel_${row.id}`,
    );
    if (!res.ok) {
      recordLog("error", "monetization_cancel_failed", { service: "monetization", route: "api/monetization/membership/cancel", attrs: { membership: row.id, status: res.status, code: res.code } });
      const status = res.status === 503 ? 503 : res.status === 404 ? 404 : 502;
      return NextResponse.json({ error: "Couldn't reach Stripe. Please try again.", code: res.code }, { status });
    }
    // Reflect locally now; the subscription webhook will confirm the same state.
    await db.from("customer_memberships")
      .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    recordLog("info", "monetization_membership_cancel_scheduled", { service: "monetization", route: "api/monetization/membership/cancel", attrs: { membership: row.id } });
    await sendMembershipCancelled({ email: user.email, planName, atPeriodEnd: true }).catch(() => false);
    return NextResponse.json({ ok: true, cancel_at_period_end: true });
  }

  // One-time membership: mark cancelled. Granted benefits keep their own expiry —
  // nothing is clawed back and nothing is refunded.
  await db.from("customer_memberships")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", row.id).in("status", ["active", "trialing", "past_due", "pending"]);
  recordLog("info", "monetization_membership_cancelled", { service: "monetization", route: "api/monetization/membership/cancel", attrs: { membership: row.id } });
  await sendMembershipCancelled({ email: user.email, planName, atPeriodEnd: false }).catch(() => false);
  return NextResponse.json({ ok: true, status: "cancelled" });
}
