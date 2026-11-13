import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "../observability";
import { systemAudit } from "../system/audit";
import {
  EMAIL_DELIVERY_EVENT_TYPES,
  hashRecipientEmail,
  isSuppressingEvent,
  type EmailDeliveryEventType,
  type NormalizedDeliveryEvent,
} from "../email-delivery/events";

/**
 * Newsletter/provider delivery-event persistence — server-only.
 *
 * Consumes NormalizedDeliveryEvent rows produced by
 * src/lib/email-delivery/events.ts (webhook route
 * /api/webhooks/email/delivery) and:
 *  1. correlates the recipient to newsletter_subscribers by email (lookup is
 *     server-side only — the raw address is NEVER written to
 *     email_delivery_events; only subscriber_id + recipient_hash are stored),
 *  2. inserts the event idempotently on (provider, provider_event_id),
 *  3. applies suppression for hard_bounce / complaint / unsubscribe using the
 *     same terminal state as the token unsubscribe flow (status='unsubscribed',
 *     unsubscribed_at set, both token hashes burned so no live link survives),
 *  4. audits 'email.delivery_event' with sanitized detail (no raw email).
 *
 * soft_bounce / deferred / accepted / delivered / failed NEVER change
 * subscriber state — they are recorded for the honest delivery ladder only.
 */

export type RecordDeliveryResult =
  | { ok: true; duplicate: boolean; suppressed: boolean; subscriberId: string | null }
  | { ok: false; status: number; error: string };

const SUPPRESSION_TYPES = new Set<EmailDeliveryEventType>(["hard_bounce", "complaint", "unsubscribe"]);

/**
 * Stores one normalized delivery event and applies suppression when required.
 * Returns duplicate=true (HTTP 200) when the provider replays an event id.
 */
export async function recordDeliveryEvent(
  db: SupabaseClient,
  ev: NormalizedDeliveryEvent,
): Promise<RecordDeliveryResult> {
  const recipientHash = hashRecipientEmail(ev.recipientEmail);

  // Correlate by address server-side; unknown recipients still get an event row.
  let subscriber: { id: string; status: string } | null = null;
  try {
    const { data, error } = await db
      .from("newsletter_subscribers")
      .select("id,status")
      .eq("email", ev.recipientEmail)
      .maybeSingle();
    if (!error && data) subscriber = data as { id: string; status: string };
  } catch {
    subscriber = null; // correlation failure must not drop the event
  }

  const { data: inserted, error } = await db
    .from("email_delivery_events")
    .insert({
      provider: ev.provider,
      provider_event_id: ev.providerEventId,
      event_type: ev.eventType,
      subscriber_id: subscriber?.id ?? null,
      recipient_hash: recipientHash,
      occurred_at: ev.occurredAt,
      payload: ev.payload,
      received_at: new Date().toISOString(),
      processed: false,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { ok: true, duplicate: true, suppressed: false, subscriberId: subscriber?.id ?? null };
    }
    recordLog("error", "email_delivery_event_insert_failed", {
      service: "email-delivery",
      attrs: { provider: ev.provider, event_type: ev.eventType, code: error.code ?? "unknown" },
    });
    return { ok: false, status: 500, error: "event_store_failed" };
  }

  const eventRowId = (inserted as { id?: string } | null)?.id ?? null;
  let suppressed = false;
  let processError: string | null = null;

  try {
    // Suppression: provider-reported hard bounce / complaint / unsubscribe maps
    // to the same terminal state as the token unsubscribe flow. Already-
    // unsubscribed rows are left untouched (idempotent).
    if (subscriber && SUPPRESSION_TYPES.has(ev.eventType) && subscriber.status !== "unsubscribed") {
      const now = new Date().toISOString();
      const { error: upErr } = await db
        .from("newsletter_subscribers")
        .update({
          status: "unsubscribed",
          unsubscribed_at: now,
          confirm_token_hash: null,
          unsubscribe_token_hash: null,
          updated_at: now,
        })
        .eq("id", subscriber.id);
      if (upErr) throw new Error(`suppression_update:${upErr.code ?? upErr.message}`);
      suppressed = true;
      recordLog("warning", "newsletter_provider_suppressed", {
        service: "newsletter",
        attrs: { provider: ev.provider, event_type: ev.eventType, subscriber_id: subscriber.id },
      });
    }
  } catch (err) {
    processError = err instanceof Error ? err.message.slice(0, 300) : "unknown";
    recordLog("error", "email_delivery_event_process_failed", {
      service: "email-delivery",
      attrs: { provider: ev.provider, event_type: ev.eventType, message: processError },
    });
  }

  // Mark the row processed (or record why it wasn't). Best-effort — the event
  // itself is already durable.
  if (eventRowId) {
    await db
      .from("email_delivery_events")
      .update({ processed: processError === null, process_error: processError })
      .eq("id", eventRowId)
      .then(() => undefined, () => undefined);
  }

  // Audit — sanitized detail only: provider, event type, ids. NEVER the email.
  await systemAudit(db, {
    actor: null,
    action: "email.delivery_event",
    resource: `email_delivery:${ev.provider}:${ev.providerEventId}`.slice(0, 200),
    detail: {
      provider: ev.provider,
      event_type: ev.eventType,
      subscriber_id: subscriber?.id ?? null,
      suppressed,
      processed: processError === null,
    },
  });

  return { ok: true, duplicate: false, suppressed, subscriberId: subscriber?.id ?? null };
}

/**
 * Latest webhook event per subscriber id (bounded: ≤500 rows, most recent
 * first). Used by getNewsletterOverview to show provider-confirmed delivery.
 * Returns {} on ANY failure — callers render "—", never a fabricated status.
 */
export async function getLatestDeliveryEvents(
  db: SupabaseClient | null,
  subscriberIds: string[],
): Promise<Record<string, { provider: string; eventType: string; occurredAt: string }>> {
  const out: Record<string, { provider: string; eventType: string; occurredAt: string }> = {};
  const ids = [...new Set(subscriberIds.filter(Boolean))].slice(0, 200);
  if (!db || ids.length === 0) return out;
  try {
    const { data, error } = await db
      .from("email_delivery_events")
      .select("subscriber_id,provider,event_type,occurred_at")
      .in("subscriber_id", ids)
      .order("occurred_at", { ascending: false })
      .limit(500);
    if (error || !Array.isArray(data)) return out;
    for (const r of data as { subscriber_id: string | null; provider: string; event_type: string; occurred_at: string }[]) {
      if (!r.subscriber_id || out[r.subscriber_id]) continue; // newest-first: first hit wins
      out[r.subscriber_id] = { provider: r.provider, eventType: r.event_type, occurredAt: r.occurred_at };
    }
    return out;
  } catch {
    return out;
  }
}

/* ── Honest delivery-state reads ───────────────────────────────────────────── */

export type DeliveryWebhookStatus = {
  /** Which provider webhook secrets are configured (env presence only). */
  resendConfigured: boolean;
  brevoConfigured: boolean;
  /** Latest stored event across providers — null when none received yet. */
  lastEventAt: string | null;
  lastEventType: EmailDeliveryEventType | null;
  lastEventProvider: string | null;
  /** Total stored events (bounded count query). */
  totalEvents: number | null;
};

/** Admin "webhook status" card data. Honest: env flags + real table reads. */
export async function getEmailDeliveryWebhookStatus(db: SupabaseClient | null): Promise<DeliveryWebhookStatus> {
  const base: DeliveryWebhookStatus = {
    resendConfigured: Boolean(process.env.RESEND_WEBHOOK_SECRET),
    brevoConfigured: Boolean(process.env.BREVO_WEBHOOK_SECRET),
    lastEventAt: null,
    lastEventType: null,
    lastEventProvider: null,
    totalEvents: null,
  };
  if (!db) return base;
  try {
    const { data: latest, error } = await db
      .from("email_delivery_events")
      .select("event_type,provider,occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(1);
    if (!error && Array.isArray(latest) && latest.length) {
      const r = latest[0] as { event_type: string; provider: string; occurred_at: string };
      base.lastEventAt = r.occurred_at;
      base.lastEventProvider = r.provider;
      base.lastEventType = (EMAIL_DELIVERY_EVENT_TYPES as readonly string[]).includes(r.event_type)
        ? (r.event_type as EmailDeliveryEventType)
        : null;
    }
    const { count, error: cErr } = await db
      .from("email_delivery_events")
      .select("id", { count: "exact", head: true });
    if (!cErr && typeof count === "number") base.totalEvents = count;
  } catch {
    /* table may not exist yet (pre-0064) — flags still honest */
  }
  return base;
}

export type SubscriberDeliveryLadder =
  | "none"
  | "queued"
  | "accepted"
  | "delivered"
  | "deferred"
  | "soft_bounced"
  | "failed"
  | "complained";

export type SubscriberDeliveryState = {
  subscriberId: string;
  /** Latest provider webhook event for this subscriber, if any. */
  event: { provider: string; eventType: EmailDeliveryEventType; occurredAt: string } | null;
  /** Latest outbox row status for this subscriber's newsletter mail. */
  outboxStatus: "queued" | "sent" | "failed" | null;
  /** Derived honest ladder — webhook events win over outbox 'sent'. */
  state: SubscriberDeliveryLadder;
};

/**
 * Pure ladder derivation (exported for tests). A webhook-confirmed 'delivered'
 * outranks outbox 'sent' (provider-accepted only); bounce/complaint events
 * surface as failed-ish states; outbox 'sent' maps to 'accepted' — the
 * provider took the message, inbox delivery unproven without a webhook.
 */
export function deriveDeliveryLadder(
  outboxStatus: "queued" | "sent" | "failed" | null,
  eventType: EmailDeliveryEventType | null,
): SubscriberDeliveryLadder {
  if (eventType) {
    switch (eventType) {
      case "delivered": return "delivered";
      case "accepted": return "accepted";
      case "deferred": return "deferred";
      case "soft_bounce": return "soft_bounced";
      case "hard_bounce":
      case "failed": return "failed";
      case "complaint": return "complained";
      case "unsubscribe": return "failed"; // suppressed — not a delivery success
    }
  }
  if (!outboxStatus) return "none";
  if (outboxStatus === "queued") return "queued";
  if (outboxStatus === "sent") return "accepted";
  return "failed";
}

/**
 * Latest delivery truth for ONE subscriber: newest webhook event + newest
 * newsletter outbox row. Returns null when the subscriber doesn't exist.
 * Never fabricates — missing data yields state 'none'/'queued' honestly.
 */
export async function getSubscriberDeliveryState(
  db: SupabaseClient | null,
  subscriberId: string,
): Promise<SubscriberDeliveryState | null> {
  if (!db) return null;
  try {
    const { data: sub, error } = await db
      .from("newsletter_subscribers")
      .select("id,email")
      .eq("id", subscriberId)
      .maybeSingle();
    if (error || !sub) return null;
    const email = String((sub as { email: string }).email).toLowerCase();

    const [evRes, obRes] = await Promise.all([
      db.from("email_delivery_events")
        .select("provider,event_type,occurred_at")
        .eq("subscriber_id", subscriberId)
        .order("occurred_at", { ascending: false })
        .limit(1),
      db.from("email_outbox")
        .select("status,created_at")
        .eq("to_email", email)
        .in("event", ["newsletter.confirm", "newsletter.welcome"])
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    const evRow = (!evRes.error && Array.isArray(evRes.data) && evRes.data.length
      ? evRes.data[0] as { provider: string; event_type: string; occurred_at: string }
      : null);
    const obRow = (!obRes.error && Array.isArray(obRes.data) && obRes.data.length
      ? obRes.data[0] as { status: string }
      : null);

    const eventType = evRow && (EMAIL_DELIVERY_EVENT_TYPES as readonly string[]).includes(evRow.event_type)
      ? (evRow.event_type as EmailDeliveryEventType)
      : null;
    const outboxStatus = obRow && ["queued", "sent", "failed"].includes(obRow.status)
      ? (obRow.status as "queued" | "sent" | "failed")
      : null;

    return {
      subscriberId,
      event: evRow && eventType
        ? { provider: evRow.provider, eventType, occurredAt: evRow.occurred_at }
        : null,
      outboxStatus,
      state: deriveDeliveryLadder(outboxStatus, eventType),
    };
  } catch {
    return null;
  }
}

export { isSuppressingEvent };
