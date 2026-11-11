import type { SupabaseClient } from "@supabase/supabase-js";
import { grant, type EntitlementUnit } from "./entitlements";
import { recordLog } from "@/lib/observability";
import { sendMembershipActivated, sendMembershipCancelled, sendMembershipPaymentFailed, sendPackagePurchased } from "@/lib/email-monetization";
import { sendGroupFunded } from "@/lib/email-groups";
import { giftClaimLink } from "@/lib/email-gifts";
import { CLAIM_TOKEN_TTL_HOURS, claimGiftUrl, generateClaimToken, hashClaimToken } from "@/lib/gifts-delivery";

/**
 * Monetization webhook handlers. Called from the Stripe webhook's handleEvent
 * for checkout.session.completed kinds and subscription/invoice lifecycle
 * events. Everything re-reads server-side rows — client metadata is a hint only.
 * Idempotent: stripe_events dedup + per-row status guards.
 */

type Obj = Record<string, unknown>;
const meta = (o: Obj) => (o.metadata as Record<string, string> | undefined) ?? {};
const str = (v: unknown) => (typeof v === "string" ? v : null);

function benefitToGrant(benefit: unknown): { unit: EntitlementUnit; amount: number } | null {
  const b = benefit as Record<string, unknown> | null;
  if (!b) return null;
  if (typeof b.rentals === "number" && b.rentals > 0) return { unit: "rental", amount: Math.floor(b.rentals) };
  if (typeof b.rental_minutes === "number" && b.rental_minutes > 0) return { unit: "minute", amount: Math.floor(b.rental_minutes) };
  if (typeof b.credit_cents === "number" && b.credit_cents > 0) return { unit: "cent", amount: Math.floor(b.credit_cents) };
  return null;
}

const periodEnd = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

const profileEmail = async (db: SupabaseClient, id: string | null | undefined) => {
  if (!id) return null;
  const { data } = await db.from("profiles").select("email").eq("id", id).maybeSingle();
  return (data as { email?: string } | null)?.email ?? null;
};
const fire = (p: Promise<unknown>) => p.catch(() => false);

async function activateOneTimeMembership(db: SupabaseClient, o: Obj) {
  const m = meta(o);
  const profileId = m.profile_id, planId = m.plan_id;
  if (!profileId || !planId) return;
  const { data: plan } = await db.from("membership_plans").select("id,name,interval,benefit,active").eq("id", planId).maybeSingle();
  if (!plan || !plan.active) { recordLog("warning", "membership_plan_inactive", { service: "monetization", attrs: { plan: planId } }); return; }
  // Dedupe: an active membership for same profile+plan already exists → skip.
  const { data: existing } = await db.from("customer_memberships")
    .select("id").eq("profile_id", profileId).eq("plan_id", planId).in("status", ["active", "trialing"]).limit(1);
  if (existing?.length) return;
  const days = plan.interval === "year" ? 365 : 30;
  const { data: mem } = await db.from("customer_memberships").insert({
    profile_id: profileId, plan_id: planId, status: "active",
    current_period_end: periodEnd(days),
  }).select("id").single();
  if (!mem) return;
  const g = benefitToGrant(plan.benefit);
  if (g) await grant(db, { profileId, kind: "membership", unit: g.unit, amount: g.amount, expiresAt: periodEnd(days), sourceType: "membership", sourceId: mem.id, actor: "webhook" });
  recordLog("info", "membership_activated", { service: "monetization", attrs: { plan: planId } });
  const email = await profileEmail(db, profileId);
  if (email) fire(sendMembershipActivated({ email, planName: plan.name, interval: plan.interval, periodEnd: periodEnd(days) }));
}

async function activateSubscription(db: SupabaseClient, o: Obj) {
  const m = meta(o);
  const profileId = m.profile_id, planId = m.plan_id;
  const subId = str(o.subscription);
  const customerId = str(o.customer);
  if (!profileId || !planId || !subId) return;
  const { data: plan } = await db.from("membership_plans").select("id,name,interval,benefit,active").eq("id", planId).maybeSingle();
  if (!plan || !plan.active) return;
  const { data: existing } = await db.from("customer_memberships").select("id,last_granted_period_end").eq("stripe_subscription_id", subId).maybeSingle();
  const days = plan.interval === "year" ? 365 : 30;
  const end = periodEnd(days);
  let memId: string;
  if (existing) {
    memId = existing.id;
    await db.from("customer_memberships").update({ status: "active", current_period_end: end, updated_at: new Date().toISOString() }).eq("id", memId);
  } else {
    const { data: mem } = await db.from("customer_memberships").insert({
      profile_id: profileId, plan_id: planId, status: "active",
      stripe_subscription_id: subId, stripe_customer_id: customerId, current_period_end: end,
    }).select("id").single();
    if (!mem) return;
    memId = mem.id;
  }
  await grantPeriodBenefits(db, memId, profileId, plan, end);
  recordLog("info", "membership_subscription_activated", { service: "monetization", attrs: { plan: planId } });
  const email = await profileEmail(db, profileId);
  if (email) fire(sendMembershipActivated({ email, planName: plan.name, interval: plan.interval, periodEnd: end }));
}

/** Grants period benefits once per period (last_granted_period_end guard). */
async function grantPeriodBenefits(db: SupabaseClient, memId: string, profileId: string, plan: { benefit: unknown; interval: string }, periodEndIso: string) {
  const { data: mem } = await db.from("customer_memberships").select("last_granted_period_end").eq("id", memId).maybeSingle();
  const last = mem?.last_granted_period_end ? Date.parse(mem.last_granted_period_end) : 0;
  if (last >= Date.parse(periodEndIso) - 1000) return; // already granted for this period
  const g = benefitToGrant(plan.benefit);
  if (g) await grant(db, { profileId, kind: "membership", unit: g.unit, amount: g.amount, expiresAt: periodEndIso, sourceType: "membership", sourceId: memId, actor: "webhook" });
  await db.from("customer_memberships").update({ last_granted_period_end: periodEndIso }).eq("id", memId);
}

type GiftFulfillRow = {
  id: string; package: string | null; value_cents: number | null;
  recipient_email: string | null; message: string | null; claim_token_hash: string | null;
};

/**
 * Secure delivery for recipient-bound gifts: mint a one-time claim token, store only
 * its sha256 + 72h expiry, and email the claim link. Best-effort — failures never fail
 * fulfillment. Idempotent: the status flip above guards webhook retries, and the
 * claim_token_hash write is additionally guarded by `.is("claim_token_hash", null)`
 * so the token+email are issued at most once per gift.
 */
async function deliverGiftClaim(db: SupabaseClient, g: GiftFulfillRow) {
  try {
    if (!g.recipient_email || g.claim_token_hash) return;
    const token = generateClaimToken(); // raw token lives only inside the emailed URL
    const { error } = await db.from("gift_credits")
      .update({ claim_token_hash: hashClaimToken(token), claim_token_expires_at: new Date(Date.now() + CLAIM_TOKEN_TTL_HOURS * 3600_000).toISOString() })
      .eq("id", g.id).is("claim_token_hash", null);
    if (error) return;
    await giftClaimLink(g.recipient_email, g.package ?? "charging gift", g.message, claimGiftUrl(token));
  } catch {
    /* delivery is best-effort; the purchaser can still share the code */
  }
}

async function fulfillGift(db: SupabaseClient, o: Obj) {
  const giftId = meta(o).gift_id;
  if (!giftId) return;
  const { data: g } = await db.from("gift_credits")
    .select("id,status,package,value_cents,recipient_email,message,claim_token_hash")
    .eq("id", giftId).maybeSingle();
  if (!g || g.status !== "pending_payment") return; // already fulfilled/refunded
  const { data: paid } = await db.from("gift_credits")
    .update({ status: "paid", stripe_payment_intent_id: str(o.payment_intent) })
    .eq("id", giftId).eq("status", "pending_payment")
    .select("id").maybeSingle();
  if (!paid) return; // lost a concurrent-fulfillment race
  recordLog("info", "gift_paid", { service: "monetization", attrs: { gift: giftId.slice(0, 8) } });
  await deliverGiftClaim(db, g as GiftFulfillRow);
}

async function fulfillPackage(db: SupabaseClient, o: Obj) {
  const m = meta(o);
  const purchaseId = m.purchase_id, profileId = m.profile_id;
  if (!purchaseId || !profileId) return;
  const { data: p } = await db.from("package_purchases").select("id,package_id,status").eq("id", purchaseId).maybeSingle();
  if (!p || p.status !== "pending") return;
  const { data: pkg } = await db.from("prepaid_packages").select("id,name,kind,units,validity_days,active").eq("id", p.package_id).maybeSingle();
  if (!pkg || !pkg.active) { recordLog("warning", "package_inactive", { service: "monetization", attrs: { package: p.package_id } }); return; }
  const expires = pkg.validity_days ? new Date(Date.now() + pkg.validity_days * 86400_000).toISOString() : null;
  const g = await grant(db, { profileId, kind: "prepaid", unit: pkg.kind as EntitlementUnit, amount: pkg.units, expiresAt: expires, sourceType: "package_purchase", sourceId: purchaseId, actor: "webhook" });
  if (!g.ok) return;
  await db.from("package_purchases").update({ status: "paid", paid_at: new Date().toISOString(), stripe_payment_intent_id: str(o.payment_intent) }).eq("id", purchaseId).eq("status", "pending");
  recordLog("info", "package_fulfilled", { service: "monetization", attrs: { package: p.package_id } });
  const email = await profileEmail(db, profileId);
  if (email) fire(sendPackagePurchased({ email, packageName: pkg.name, kind: pkg.kind, units: pkg.units, validityDays: pkg.validity_days }));
}

async function fulfillEventPass(db: SupabaseClient, o: Obj) {
  const passId = meta(o).pass_id;
  if (!passId) return;
  await db.from("event_passes").update({ paid_at: new Date().toISOString(), stripe_checkout_session_id: str(o.id) }).eq("id", passId).is("paid_at", null);
  recordLog("info", "event_pass_paid", { service: "monetization", attrs: { pass: passId.slice(0, 8) } });
}

/**
 * Group self-serve pool funding. The purchase row is re-read server-side;
 * fund_group_credit RPC atomically marks it paid, increments
 * rental_groups.credit_cents and writes the entitlement_events audit row.
 * The RPC returns false for non-pending rows, so webhook replays are safe.
 */
async function fulfillGroupFunding(db: SupabaseClient, o: Obj) {
  const purchaseId = meta(o).purchase_id;
  if (!purchaseId) return;
  const { data: p } = await db.from("group_credit_purchases")
    .select("id,group_id,organizer_id,amount_cents,status").eq("id", purchaseId).maybeSingle();
  const purchase = p as { id: string; group_id: string; organizer_id: string; amount_cents: number; status: string } | null;
  if (!purchase) return;
  // The RPC owns the pending guard — it returns false for paid/refunded rows,
  // so webhook replays and late events are safe no-ops.
  const { data: funded, error } = await db.rpc("fund_group_credit", { p_purchase_id: purchase.id });
  if (error) {
    recordLog("warning", "group_funding_rpc_failed", { service: "monetization", attrs: { purchase: purchase.id.slice(0, 8), err: String((error as { message?: string }).message ?? error).slice(0, 160) } });
    return;
  }
  if (funded !== true) return; // lost a replay race — already funded
  await db.from("group_credit_purchases").update({ stripe_payment_intent_id: str(o.payment_intent) }).eq("id", purchase.id);
  recordLog("info", "group_credit_funded", { service: "monetization", attrs: { group: purchase.group_id.slice(0, 8), purchase: purchase.id.slice(0, 8) } });
  const [{ data: group }, email] = await Promise.all([
    db.from("rental_groups").select("name").eq("id", purchase.group_id).maybeSingle(),
    profileEmail(db, purchase.organizer_id),
  ]);
  if (email) fire(sendGroupFunded({
    email, groupId: purchase.group_id,
    groupName: (group as { name?: string } | null)?.name ?? "your group",
    amountCents: purchase.amount_cents,
  }));
}

/** Returns true if the event was a monetization event (handled or safely ignored). */
export async function handleMonetizationEvent(db: SupabaseClient, event: { type: string; data: { object: Obj } }): Promise<boolean> {
  const o = event.data.object;
  const m = meta(o);
  switch (event.type) {
    case "checkout.session.completed": {
      switch (m.kind) {
        case "membership": await activateOneTimeMembership(db, o); return true;
        case "membership_subscription": await activateSubscription(db, o); return true;
        case "gift_credit": await fulfillGift(db, o); return true;
        case "package": await fulfillPackage(db, o); return true;
        case "event_pass": await fulfillEventPass(db, o); return true;
        case "group_funding": await fulfillGroupFunding(db, o); return true;
        default: return false;
      }
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subId = str(o.id);
      if (!subId) return true;
      const status = str(o.status);
      const periodEndTs = (o.items as { data?: { current_period_end?: number }[] } | undefined)?.data?.[0]?.current_period_end;
      const map: Record<string, string> = { active: "active", trialing: "trialing", past_due: "past_due", canceled: "cancelled", unpaid: "past_due", incomplete_expired: "expired", paused: "past_due" };
      const newStatus = map[status ?? ""] ?? "past_due";
      const { data: mem } = await db.from("customer_memberships").select("id,profile_id,plan_id").eq("stripe_subscription_id", subId).maybeSingle();
      if (mem) {
        await db.from("customer_memberships").update({
          status: newStatus,
          current_period_end: typeof periodEndTs === "number" ? new Date(periodEndTs * 1000).toISOString() : undefined,
          cancel_at_period_end: o.cancel_at_period_end === true,
          updated_at: new Date().toISOString(),
        }).eq("id", mem.id);
        // Renewal: grant next period's benefits when Stripe reports a new period end.
        if (newStatus === "active" && typeof periodEndTs === "number") {
          const { data: plan } = await db.from("membership_plans").select("benefit,interval").eq("id", mem.plan_id).maybeSingle();
          if (plan) await grantPeriodBenefits(db, mem.id, mem.profile_id, plan, new Date(periodEndTs * 1000).toISOString());
        }
      }
      return true;
    }
    case "customer.subscription.deleted": {
      const subId = str(o.id);
      if (!subId) return true;
      const { data: mem } = await db.from("customer_memberships").select("profile_id,plan_id").eq("stripe_subscription_id", subId).maybeSingle();
      await db.from("customer_memberships").update({ status: "cancelled", cancel_at_period_end: false, updated_at: new Date().toISOString() }).eq("stripe_subscription_id", subId);
      if (mem) {
        const [{ data: plan }, email] = await Promise.all([
          db.from("membership_plans").select("name").eq("id", mem.plan_id).maybeSingle(),
          profileEmail(db, mem.profile_id),
        ]);
        if (email) fire(sendMembershipCancelled({ email, planName: (plan as { name?: string } | null)?.name ?? null }));
      }
      return true;
    }
    case "invoice.payment_failed": {
      // Subscription renewal failure → past_due (access continues per Stripe's retry window).
      const subId = str((o.subscription_details as Obj | undefined)?.subscription ?? o.subscription);
      if (subId) {
        const { data: mem } = await db.from("customer_memberships").select("profile_id,plan_id").eq("stripe_subscription_id", subId).maybeSingle();
        await db.from("customer_memberships").update({ status: "past_due", updated_at: new Date().toISOString() }).eq("stripe_subscription_id", subId);
        if (mem) {
          const [{ data: plan }, email] = await Promise.all([
            db.from("membership_plans").select("name").eq("id", mem.plan_id).maybeSingle(),
            profileEmail(db, mem.profile_id),
          ]);
          if (email) fire(sendMembershipPaymentFailed({ email, planName: (plan as { name?: string } | null)?.name ?? null }));
        }
      }
      return true;
    }
    default:
      return false;
  }
}
