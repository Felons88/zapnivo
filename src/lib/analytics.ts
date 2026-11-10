import { randomUUID } from "node:crypto";
import { serviceClient } from "./supabase";

/**
 * Analytics: consent-gated client events + first-party business event pipeline.
 * Client events fire only after consent (ConsentBanner → CONSENT_KEY). No PII
 * ever leaves the browser: no emails, phones, names, tokens, or message content.
 */

export const CONSENT_KEY = "zapnivo_consent";

/** Legacy client-side catalogue — fires into window.__zapnivoAnalytics when a sink is attached. */
export const EVENTS = [
  "homepage_view",
  "business_cta_click",
  "venue_application_start",
  "venue_application_complete",
  "station_search",
  "rental_checkout_start",
  "payment_authorized",
  "dispense_confirmed",
  "return_confirmed",
  "support_request_submitted",
  "advertising_inquiry_submitted",
] as const;
export type AnalyticsEvent = (typeof EVENTS)[number];

export function track(event: AnalyticsEvent, props?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(CONSENT_KEY) !== "granted") return;
  const sink = (window as unknown as { __zapnivoAnalytics?: (e: string, p?: object) => void }).__zapnivoAnalytics;
  sink?.(event, props);
}

/* ── First-party business event pipeline ─────────────────────────────────── */

/** Public event names accepted by POST /api/events. Lifecycle-critical events are server-only. */
export const PUBLIC_EVENT_NAMES = [
  // acquisition
  "page_view", "session_start", "view_business_page", "view_station_locations",
  "click_partner_cta", "click_find_station", "click_contact", "view_pricing",
  // partner funnel
  "partner_application_started", "partner_application_step", "partner_application_submitted",
  "partner_application_abandoned",
  // rental funnel (client-observed steps only — completion is server-authoritative)
  "rental_qr_opened", "rental_checkout_started", "rental_terms_accepted",
  "rental_payment_started", "rental_payment_failed", "rental_return_problem",
  // support engagement
  "support_chat_opened", "support_question_submitted", "support_auth_requested",
  "support_otp_requested", "support_otp_verified", "support_ticket_created",
  // retention
  "customer_return_visit", "customer_feedback_submitted",
] as const;
export type PublicEventName = (typeof PUBLIC_EVENT_NAMES)[number];

/** Server-authoritative lifecycle events — never accepted from the public endpoint. */
export const SERVER_EVENT_NAMES = [
  "partner_application_approved", "partner_application_submitted",
  "rental_started", "rental_completed", "rental_refunded", "rental_payment_failed",
  "support_ticket_created", "support_ai_resolved", "support_human_escalated",
] as const;
export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];

const MAX_PROPS = 12;
const PROP_KEY = /^[a-z][a-z0-9_]{0,40}$/;
const PROP_VALUE = /^[\w\-./: ]{0,120}$/;
const FORBIDDEN_KEY = /email|phone|name|token|secret|password|card|cvv|message|body|transcript|address/i;

/** Keeps only short scalar props on the allowlist shape; drops anything PII-shaped. */
export function sanitizeProps(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROPS) break;
    if (!PROP_KEY.test(k) || FORBIDDEN_KEY.test(k)) continue;
    if (typeof v === "string" && PROP_VALUE.test(v)) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function isPublicEvent(name: string): name is PublicEventName {
  return (PUBLIC_EVENT_NAMES as readonly string[]).includes(name);
}

/** Server-side emit for trusted lifecycle transitions. Never throws — analytics must not break requests. */
export function trackServer(e: {
  name: ServerEventName;
  entityType?: string;
  entityId?: string;
  actorId?: string | null;
  props?: Record<string, unknown>;
  sessionRef?: string | null;
}): void {
  try {
    const db = serviceClient();
    if (!db) return;
    void db.from("business_events").insert({
      name: e.name,
      source: "server",
      actor_id: e.actorId ?? null,
      entity_type: e.entityType ?? null,
      entity_id: e.entityId ?? null,
      session_ref: e.sessionRef ?? null,
      props: sanitizeProps(e.props),
      privacy_class: "internal",
    }).then(() => undefined, () => undefined);
  } catch { /* analytics must never break a request */ }
}

export const newEventId = () => randomUUID();
