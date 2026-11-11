import type { SupabaseClient } from "@supabase/supabase-js";
import { grant, type EntitlementUnit } from "./entitlements";
import { recordLog } from "@/lib/observability";
import { auditLog } from "@/lib/audit";
import { retrievePaymentIntent } from "@/lib/stripe";
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
  }).select("id,created_at").single();
  if (!mem) return;
  const g = benefitToGrant(plan.benefit);
  if (g) await grant(db, { profileId, kind: "membership", unit: g.unit, amount: g.amount, expiresAt: periodEnd(days), sourceType: "membership", sourceId: mem.id, actor: "webhook" });
  // No unique constraint on (profile_id, plan_id) exists — two checkout sessions
  // completing concurrently can both pass the `existing` check above. The
  // dedupe sweep below cancels every duplicate past the first and revokes the
  // grants sourced from it, so the double-grant self-heals on the next pass.
  // Residual risk: two truly-simultaneous inserts can both miss each other's
  // rows; needs a unique index migration to fully close.
  await dedupeOneTimeMemberships(db, profileId, planId);
  recordLog("info", "membership_activated", { service: "monetization", attrs: { plan: planId } });
  const email = await profileEmail(db, profileId);
  if (email) fire(sendMembershipActivated({ email, planName: plan.name, interval: plan.interval, periodEnd: periodEnd(days) }));
}

/**
 * Keeps the earliest active/trialing membership for (profile, plan) and cancels
 * any duplicates, revoking the entitlement grants each duplicate issued
 * (source_type 'membership', source_id = membership id). Guarded updates make
 * it idempotent and safe to run from concurrent webhook deliveries.
 */
async function dedupeOneTimeMemberships(db: SupabaseClient, profileId: string, planId: string) {
  try {
    const { data: rows } = await db.from("customer_memberships")
      .select("id,status,created_at").eq("profile_id", profileId).eq("plan_id", planId)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: true }).order("id", { ascending: true });
    const list = (rows ?? []) as { id: string; created_at: string | null }[];
    if (list.length < 2) return;
    for (const dup of list.slice(1)) {
      const { data: cancelled } = await db.from("customer_memberships")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", dup.id).in("status", ["active", "trialing"])
        .select("id").maybeSingle();
      if (!cancelled) continue;
      const { data: grants } = await db.from("entitlement_grants")
        .select("id,remaining").eq("source_type", "membership").eq("source_id", dup.id).eq("status", "active");
      for (const gr of (grants ?? []) as { id: string; remaining: number }[]) {
        const { error: revErr } = await db.from("entitlement_grants")
          .update({ status: "revoked", remaining: 0, updated_at: new Date().toISOString() })
          .eq("id", gr.id).eq("status", "active");
        if (revErr) continue;
        await db.from("entitlement_events").insert({
          grant_id: gr.id, profile_id: profileId, event: "refund",
          delta: -gr.remaining, balance_after: 0, ref_type: "membership", ref_id: dup.id,
          actor: "webhook", note: "duplicate one-time membership purchase",
        });
      }
      recordLog("warning", "membership_duplicate_cancelled", { service: "monetization", attrs: { plan: planId, membership: dup.id.slice(0, 8) } });
    }
  } catch (e) {
    recordLog("warning", "membership_dedupe_failed", { service: "monetization", attrs: { plan: planId, err: e instanceof Error ? e.message.slice(0, 120) : "unknown" } });
  }
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
      // claim_policy 'recipient' (migration 0040): claim_gift requires the claiming
      // profile's email to match recipient_email. Gifts without a recipient never
      // reach this code path and keep the default 'bearer' policy.
      .update({ claim_token_hash: hashClaimToken(token), claim_token_expires_at: new Date(Date.now() + CLAIM_TOKEN_TTL_HOURS * 3600_000).toISOString(), claim_policy: "recipient" })
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
  // Flip pending→paid FIRST (guarded): only the caller that wins this update may
  // grant. Granting before the flip let a webhook retry/crash double-grant.
  const { data: paid } = await db.from("package_purchases")
    .update({ status: "paid", paid_at: new Date().toISOString(), stripe_payment_intent_id: str(o.payment_intent) })
    .eq("id", purchaseId).eq("status", "pending")
    .select("id").maybeSingle();
  if (!paid) return; // lost a concurrent-fulfillment race — already paid
  const expires = pkg.validity_days ? new Date(Date.now() + pkg.validity_days * 86400_000).toISOString() : null;
  const g = await grant(db, { profileId, kind: "prepaid", unit: pkg.kind as EntitlementUnit, amount: pkg.units, expiresAt: expires, sourceType: "package_purchase", sourceId: purchaseId, actor: "webhook" });
  if (!g.ok) {
    // Paid but ungranted: leave 'paid' (never re-grant on replay) and flag for
    // staff reconciliation — the customer paid, so this needs a human.
    recordLog("error", "package_fulfillment_failed", { service: "monetization", attrs: { purchase: purchaseId.slice(0, 8), package: p.package_id, err: g.error.slice(0, 160) } });
    return;
  }
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

/* ── Refund / dispute reconciliation ────────────────────────────────────────
 * charge.refunded and charge.dispute.* only carried rental `payments` lookups,
 * so monetization PaymentIntents were invisible. These handlers resolve a
 * charge's PaymentIntent back to the product row (DB stripe_payment_intent_id
 * columns first; event_passes/memberships have no PI column, so the checkout
 * metadata copied onto the PaymentIntent is the fallback) and reconcile
 * idempotently. Disputes are log+audit only — no automatic action.
 */

type ChargeProduct =
  | { kind: "gift_credit" | "package" | "group_funding" | "event_pass"; id: string }
  | { kind: "membership"; profileId: string; planId: string }
  | { kind: "membership_subscription" };

const MONETIZATION_KINDS = new Set(["gift_credit", "package", "group_funding", "event_pass", "membership", "membership_subscription"]);

const refLabel = (r: ChargeProduct) =>
  "id" in r ? r.id : r.kind === "membership" ? `${r.kind}:${r.profileId}` : r.kind;

async function resolveChargeProduct(db: SupabaseClient, piId: string): Promise<ChargeProduct | null> {
  // Rows that persist stripe_payment_intent_id at fulfillment time.
  for (const [table, kind] of [["gift_credits", "gift_credit"], ["package_purchases", "package"], ["group_credit_purchases", "group_funding"]] as const) {
    const { data } = await db.from(table).select("id").eq("stripe_payment_intent_id", piId).limit(1);
    const row = (data ?? [])[0] as { id?: string } | undefined;
    if (row?.id) return { kind, id: row.id };
  }
  // event_passes / customer_memberships never store the PI — recover the
  // checkout metadata Stripe copied onto the PaymentIntent (payment_intent_data.metadata).
  try {
    const res = await retrievePaymentIntent(piId);
    if (!res.ok) return null;
    const m = ((res.data as { metadata?: Record<string, string> } | undefined)?.metadata) ?? {};
    if (!MONETIZATION_KINDS.has(m.kind ?? "")) return null;
    if (m.kind === "gift_credit" && m.gift_id) return { kind: "gift_credit", id: m.gift_id };
    if (m.kind === "package" && m.purchase_id) return { kind: "package", id: m.purchase_id };
    if (m.kind === "group_funding" && m.purchase_id) return { kind: "group_funding", id: m.purchase_id };
    if (m.kind === "event_pass" && m.pass_id) return { kind: "event_pass", id: m.pass_id };
    if (m.kind === "membership" && m.profile_id && m.plan_id) return { kind: "membership", profileId: m.profile_id, planId: m.plan_id };
    if (m.kind === "membership_subscription") return { kind: "membership_subscription" };
  } catch { /* Stripe unreachable — unresolved is safe (caller falls through) */ }
  return null;
}

/** Revokes active grants issued from a source row; writes entitlement_events 'refund' per grant. Idempotent via status guards. */
async function revokeSourceGrants(db: SupabaseClient, sourceType: string, sourceId: string, refType: string, note: string): Promise<number> {
  const { data: grants } = await db.from("entitlement_grants")
    .select("id,profile_id,remaining").eq("source_type", sourceType).eq("source_id", sourceId).eq("status", "active");
  let revoked = 0;
  for (const g of (grants ?? []) as { id: string; profile_id: string; remaining: number }[]) {
    const { error } = await db.from("entitlement_grants")
      .update({ status: "revoked", remaining: 0, updated_at: new Date().toISOString() })
      .eq("id", g.id).eq("status", "active");
    if (error) continue;
    await db.from("entitlement_events").insert({
      grant_id: g.id, profile_id: g.profile_id, event: "refund",
      delta: -g.remaining, balance_after: 0, ref_type: refType, ref_id: sourceId,
      actor: "webhook", note,
    });
    revoked += 1;
  }
  return revoked;
}

const guardedFlip = (db: SupabaseClient, table: string, id: string, from: string[], to: Record<string, unknown>) =>
  db.from(table).update(to).eq("id", id).in("status", from).select("id").maybeSingle();

/**
 * charge.refunded reconciliation for monetization products. Returns true when
 * the charge resolved to a monetization product (handled — including partial
 * refunds, which are logged for staff); false lets the caller continue to the
 * rental `payments` path. Full refunds flip the row and revoke entitlements.
 */
export async function handleMonetizationRefund(db: SupabaseClient, o: Obj): Promise<boolean> {
  const piId = str(o.payment_intent);
  if (!piId) return false;
  const ref = await resolveChargeProduct(db, piId);
  if (!ref) return false;
  const refunded = typeof o.amount_refunded === "number" ? o.amount_refunded : 0;
  const captured = typeof o.amount_captured === "number" ? o.amount_captured : typeof o.amount === "number" ? o.amount : 0;
  const full = refunded > 0 && captured > 0 && refunded >= captured;
  const label = refLabel(ref);
  if (!full) {
    recordLog("info", "monetization_partial_refund", { service: "monetization", attrs: { kind: ref.kind, ref: label.slice(0, 12), refunded, captured } });
    return true;
  }
  const now = new Date().toISOString();
  try {
    switch (ref.kind) {
      case "gift_credit": {
        const { data: g } = await db.from("gift_credits").select("id,status").eq("id", ref.id).maybeSingle();
        if (!g || !["paid", "redeemed"].includes(g.status)) break;
        const { data: flipped } = await guardedFlip(db, "gift_credits", ref.id, ["paid", "redeemed"], { status: "refunded", refunded_at: now });
        if (!flipped) break;
        const revoked = await revokeSourceGrants(db, "gift_credit", ref.id, "gift", "gift refund (Stripe charge.refunded)");
        recordLog("info", "gift_refunded_webhook", { service: "monetization", attrs: { gift: ref.id.slice(0, 8), revoked } });
        break;
      }
      case "package": {
        const { data: p } = await db.from("package_purchases").select("id,status,profile_id").eq("id", ref.id).maybeSingle();
        if (!p || !["paid", "redeemed"].includes(p.status)) break;
        const { data: flipped } = await guardedFlip(db, "package_purchases", ref.id, ["paid", "redeemed"], { status: "refunded" });
        if (!flipped) break;
        const revoked = await revokeSourceGrants(db, "package_purchase", ref.id, "package_purchase", "package refund (Stripe charge.refunded)");
        recordLog("info", "package_refunded_webhook", { service: "monetization", attrs: { purchase: ref.id.slice(0, 8), revoked } });
        break;
      }
      case "group_funding": {
        const { data: p } = await db.from("group_credit_purchases").select("id,group_id,amount_cents,status").eq("id", ref.id).maybeSingle();
        const purchase = p as { id: string; group_id: string; amount_cents: number; status: string } | null;
        if (!purchase || purchase.status !== "paid") break;
        const { data: flipped } = await guardedFlip(db, "group_credit_purchases", ref.id, ["paid"], { status: "refunded" });
        if (!flipped) break;
        const { error: rpcErr } = await db.rpc("adjust_group_credit", {
          p_group: purchase.group_id, p_delta: -purchase.amount_cents,
          p_actor: "system:stripe_refund", p_note: "Group funding refund (Stripe charge.refunded)",
        });
        if (rpcErr) {
          // Restore 'paid' so the refund can be retried/reconciled cleanly.
          await db.from("group_credit_purchases").update({ status: "paid" }).eq("id", ref.id).eq("status", "refunded");
          recordLog("error", "group_funding_refund_rpc_failed", { service: "monetization", attrs: { purchase: ref.id.slice(0, 8), err: String(rpcErr.message ?? rpcErr).slice(0, 160) } });
          break;
        }
        recordLog("info", "group_funding_refunded_webhook", { service: "monetization", attrs: { purchase: ref.id.slice(0, 8), group: purchase.group_id.slice(0, 8) } });
        break;
      }
      case "event_pass": {
        const { data: pass } = await db.from("event_passes").select("id,status,holder_id").eq("id", ref.id).maybeSingle();
        const p = pass as { id: string; status: string; holder_id: string | null } | null;
        if (!p) break;
        if (p.status === "active") {
          await db.from("event_passes").update({ status: "revoked" }).eq("id", p.id).eq("status", "active");
          recordLog("info", "event_pass_refunded_webhook", { service: "monetization", attrs: { pass: p.id.slice(0, 8) } });
        } else {
          // Redeemed/expired pass: grants may already be consumed — flag for staff.
          recordLog("warning", "event_pass_refund_needs_review", { service: "monetization", attrs: { pass: p.id.slice(0, 8), status: p.status } });
        }
        break;
      }
      case "membership": {
        const { data: mem } = await db.from("customer_memberships")
          .select("id,status").eq("profile_id", ref.profileId).eq("plan_id", ref.planId)
          .in("status", ["active", "trialing", "past_due"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const m = mem as { id: string; status: string } | null;
        if (!m) break;
        const { data: flipped } = await db.from("customer_memberships")
          .update({ status: "cancelled", updated_at: now })
          .eq("id", m.id).in("status", ["active", "trialing", "past_due"])
          .select("id").maybeSingle();
        if (!flipped) break;
        const revoked = await revokeSourceGrants(db, "membership", m.id, "membership", "membership refund (Stripe charge.refunded)");
        recordLog("info", "membership_refunded_webhook", { service: "monetization", attrs: { membership: m.id.slice(0, 8), revoked } });
        break;
      }
      case "membership_subscription": {
        // Subscription invoice refunds can't be tied to a period without more
        // data — flag for staff reconciliation.
        recordLog("warning", "membership_refund_needs_review", { service: "monetization", attrs: { pi: piId.slice(0, 14) } });
        break;
      }
    }
  } catch (e) {
    recordLog("error", "monetization_refund_failed", { service: "monetization", attrs: { kind: ref.kind, ref: label.slice(0, 12), err: e instanceof Error ? e.message.slice(0, 160) : "unknown" } });
  }
  return true;
}

/**
 * charge.dispute.* for monetization charges: record + audit only, no automatic
 * action (funds are already withdrawn by Stripe; staff decide next steps).
 * Returns true when the dispute resolved to a monetization product.
 */
export async function handleMonetizationDispute(db: SupabaseClient, o: Obj): Promise<boolean> {
  const piId = str(o.payment_intent);
  if (!piId) return false;
  const ref = await resolveChargeProduct(db, piId);
  if (!ref) return false;
  const detail = {
    kind: ref.kind,
    ref: refLabel(ref).slice(0, 40),
    dispute: str(o.id), reason: str(o.reason), status: str(o.status),
    amount: typeof o.amount === "number" ? o.amount : null,
    currency: str(o.currency),
  };
  recordLog("warning", "monetization_dispute", { service: "monetization", attrs: detail });
  await auditLog(null, "stripe_dispute", ref.kind, "id" in ref ? ref.id : piId, detail);
  return true;
}
