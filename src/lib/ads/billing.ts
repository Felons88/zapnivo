import type { SupabaseClient } from "@supabase/supabase-js";
import { trackServer } from "../analytics";
import { recordLog } from "../observability";

/**
 * Advertising billing — server-only (service role). Two jobs:
 *  1. campaignAmountCents(): resolve what a campaign owes before checkout.
 *  2. Webhook reconciliation: checkout.session.completed / payment_intent.* /
 *     charge.refunded events with metadata.kind === 'ad_campaign' land in
 *     advertising_campaigns + ad_ledger. Nothing here trusts client metadata —
 *     every handler re-reads the campaign row and all writes are conditional on
 *     current state so Stripe retries and duplicate events are safe.
 */

type Db = SupabaseClient;
type WebhookObject = Record<string, unknown> & { id: string };

const adsLog = (message: string, attrs?: Record<string, unknown>) =>
  recordLog("info", message, { service: "ads", route: "webhooks/stripe", attrs });

export type AdCampaignRow = {
  id: string;
  advertiser_org_id: string | null;
  name: string | null;
  status: string;
  budget_cents: number | null;
  spent_cents: number | null;
  payment_status: string;
  pricing_model: string;
  targeting: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
  stripe_payment_intent_id?: string | null;
  stripe_checkout_session_id?: string | null;
};

export type AdRateCardRow = {
  id: string;
  placement: string;
  pricing_model: string;
  unit_price_cents: number;
  min_spend_cents: number;
  duration_days: number;
};

export const AD_PLACEMENT_DEFAULT = "kiosk_screen";

/** Placement comes from campaign.targeting.placement; anything else falls back to kiosk screens. */
export function campaignPlacement(campaign: { targeting?: Record<string, unknown> | null }): string {
  const p = campaign.targeting?.placement;
  return typeof p === "string" && p.trim().length > 0 ? p.trim() : AD_PLACEMENT_DEFAULT;
}

/** Whole days between schedule.starts_at and schedule.ends_at, or null when the window isn't usable. */
function scheduleDays(campaign: AdCampaignRow): number | null {
  const sched = campaign.schedule ?? {};
  const start = Date.parse(typeof sched.starts_at === "string" ? sched.starts_at : "");
  const end = Date.parse(typeof sched.ends_at === "string" ? sched.ends_at : "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(1, Math.ceil((end - start) / 86_400_000));
}

export type CampaignAmount = {
  amountCents: number;
  /** What is actually charged: fixed = rate-card price (or budget fallback); cpm/cpc = prepaid budget. */
  model: "fixed" | "cpm" | "cpc";
  placement: string;
  days?: number;
  unitPriceCents?: number;
  minSpendCents?: number;
  budgetCents?: number | null;
};

/**
 * Resolves the amount due for a campaign. Fixed pricing uses the active rate card
 * for the campaign's placement: unit_price_cents × days, where days is the scheduled
 * window clamped up to the card's minimum duration_days. With no rate card the
 * campaign's budget_cents is the fixed price. Usage models (cpm/cpc) are prepaid:
 * the full budget_cents is charged up front and drawn down by verified ad_events.
 * Returns null when no honest price exists — the caller must not open checkout.
 */
export async function campaignAmountCents(db: Db, campaign: AdCampaignRow): Promise<CampaignAmount | null> {
  const placement = campaignPlacement(campaign);
  const model = campaign.pricing_model === "cpm" || campaign.pricing_model === "cpc" ? campaign.pricing_model : "fixed";
  const budget = typeof campaign.budget_cents === "number" && campaign.budget_cents > 0 ? campaign.budget_cents : null;

  const { data: cards, error } = await db.from("ad_rate_cards")
    .select("id,placement,pricing_model,unit_price_cents,min_spend_cents,duration_days")
    .eq("active", true).eq("placement", placement);
  if (error) throw new Error("ad_rate_card_lookup_failed");
  const card = ((cards ?? []) as AdRateCardRow[]).find((c) => c.pricing_model === model);

  if (model !== "fixed") {
    const amountCents = budget ?? (card && card.min_spend_cents > 0 ? card.min_spend_cents : null);
    if (amountCents === null || amountCents <= 0) return null;
    return {
      amountCents, model, placement, budgetCents: budget,
      unitPriceCents: card?.unit_price_cents ?? 0, minSpendCents: card?.min_spend_cents ?? 0,
    };
  }

  if (card) {
    const days = Math.max(scheduleDays(campaign) ?? card.duration_days, card.duration_days);
    const amountCents = card.unit_price_cents * days;
    if (amountCents <= 0) return null;
    return {
      amountCents, model: "fixed", placement, days, budgetCents: budget,
      unitPriceCents: card.unit_price_cents, minSpendCents: card.min_spend_cents,
    };
  }

  if (budget === null) return null;
  return { amountCents: budget, model: "fixed", placement, budgetCents: budget };
}

/* ───────────── webhook reconciliation ───────────── */

async function writeOk(p: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await p;
  if (error) throw new Error("ad_billing_write_failed");
}

const metaOf = (o: WebhookObject) => (o.metadata as Record<string, string> | undefined) ?? {};

/**
 * checkout.session.completed for an ad campaign (payment mode = immediate capture).
 * Authoritative for the campaign's payment_status; idempotent — an already-paid
 * campaign returns early and the ledger charge is keyed by the PaymentIntent.
 * Moves an approved campaign to 'scheduled' only; activation stays with staff.
 */
export async function handleAdCheckoutCompleted(db: Db, o: WebhookObject): Promise<boolean> {
  const campaignId = metaOf(o).campaign_id;
  if (!campaignId) return false;

  const { data: found } = await db.from("advertising_campaigns")
    .select("id,advertiser_org_id,name,status,payment_status,budget_cents,stripe_payment_intent_id")
    .eq("id", campaignId).maybeSingle();
  const campaign = found as unknown as AdCampaignRow | null;
  if (!campaign) return true;
  if (campaign.payment_status === "paid") return true;

  const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
  const amount = typeof o.amount_total === "number" ? o.amount_total
    : typeof campaign.budget_cents === "number" ? campaign.budget_cents : null;
  if (amount === null || amount <= 0) throw new Error("ad_checkout_missing_amount");

  const patch: Record<string, unknown> = {
    payment_status: "paid",
    stripe_payment_intent_id: piId ?? undefined,
    stripe_checkout_session_id: o.id,
  };
  if (campaign.status === "approved") patch.status = "scheduled";
  await writeOk(db.from("advertising_campaigns").update(patch).eq("id", campaign.id).neq("payment_status", "paid"));

  if (piId) {
    const { data: existing } = await db.from("ad_ledger").select("id")
      .eq("campaign_id", campaign.id).eq("kind", "charge").eq("stripe_payment_intent_id", piId).limit(1);
    if (!existing || existing.length === 0) {
      await writeOk(db.from("ad_ledger").insert({
        campaign_id: campaign.id, kind: "charge", amount_cents: amount,
        currency: typeof o.currency === "string" ? o.currency : "usd",
        stripe_payment_intent_id: piId, status: "succeeded", note: "campaign_prepayment",
      }));
    }
  }

  const orgId = campaign.advertiser_org_id ?? metaOf(o).advertiser_org_id ?? null;
  const customerId = typeof o.customer === "string" ? o.customer : null;
  if (orgId && customerId) {
    await writeOk(db.from("advertiser_orgs").update({ stripe_customer_id: customerId }).eq("id", orgId).is("stripe_customer_id", null));
  }

  trackServer({ name: "ad_campaign_paid", entityType: "ad_campaign", entityId: campaign.id, props: { amount_cents: amount } });
  adsLog("ad_campaign_paid", { campaignId: campaign.id, amountCents: amount, paymentIntentId: piId });
  return true;
}

/**
 * payment_intent.succeeded / payment_intent.payment_failed for an ad campaign.
 * checkout.session.completed stays authoritative for payment_status; these events
 * only reconcile ad_ledger rows still 'pending' so nothing double-counts.
 */
export async function handleAdPaymentIntent(db: Db, o: WebhookObject, outcome: "succeeded" | "failed"): Promise<boolean> {
  const status = outcome === "succeeded" ? "succeeded" : "failed";
  await writeOk(db.from("ad_ledger").update({ status })
    .eq("stripe_payment_intent_id", o.id).eq("status", "pending"));
  adsLog("ad_payment_intent", { outcome, campaignId: metaOf(o).campaign_id ?? null, paymentIntentId: o.id });
  const campaignId = metaOf(o).campaign_id;
  if (outcome === "failed" && campaignId) {
    await writeOk(db.from("advertising_campaigns").update({ payment_status: "failed" })
      .eq("id", campaignId).eq("payment_status", "checkout_pending"));
  } else if (outcome === "succeeded") {
    // Late PI event (session.completed may have raced): reconcile a campaign still
    // waiting on this exact PaymentIntent without touching paid/failed states.
    await writeOk(db.from("advertising_campaigns").update({ payment_status: "paid" })
      .eq("stripe_payment_intent_id", o.id).eq("payment_status", "checkout_pending"));
  }
  return true;
}

/**
 * charge.refunded for a PaymentIntent that owns ad_ledger rows. Returns false when
 * the charge isn't ours so the rental refund path still runs. Ledger rows and the
 * campaign only flip to 'refunded' on a FULL refund; partial refunds leave the
 * ledger 'succeeded' (Stripe remains the record of the partial amount).
 */
export async function handleAdChargeRefunded(db: Db, o: WebhookObject): Promise<boolean> {
  const piId = typeof o.payment_intent === "string" ? o.payment_intent : null;
  if (!piId) return false;
  const { data: rows } = await db.from("ad_ledger").select("id,campaign_id,kind,status")
    .eq("stripe_payment_intent_id", piId).eq("kind", "charge");
  const charges = (rows ?? []) as { id: string; campaign_id: string; status: string }[];
  if (charges.length === 0) return false;

  const refunded = typeof o.amount_refunded === "number" ? o.amount_refunded : 0;
  const captured = typeof o.amount === "number" ? o.amount : 0;
  if (!(captured > 0 && refunded >= captured)) return true;

  const refundId = ((o.refunds as { data?: { id?: string }[] } | undefined)?.data ?? [])[0]?.id ?? null;
  await writeOk(db.from("ad_ledger").update({ status: "refunded", ...(refundId ? { stripe_refund_id: refundId } : {}) })
    .eq("stripe_payment_intent_id", piId).eq("kind", "charge").in("status", ["pending", "succeeded"]));
  for (const campaignId of new Set(charges.map((c) => c.campaign_id))) {
    await writeOk(db.from("advertising_campaigns").update({ payment_status: "refunded" })
      .eq("id", campaignId).eq("payment_status", "paid"));
  }
  adsLog("ad_charge_refunded", { paymentIntentId: piId, campaigns: new Set(charges.map((c) => c.campaign_id)).size, amountRefundedCents: refunded });
  return true;
}
