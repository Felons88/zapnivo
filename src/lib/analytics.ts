/**
 * Analytics event catalogue. Events fire only after cookie/analytics consent is granted
 * (see ConsentBanner). No provider is bundled yet; wire `sink` to Plausible/PostHog/GA when chosen.
 */
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

export const CONSENT_KEY = "zapnivo_consent";

export function track(event: AnalyticsEvent, props?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(CONSENT_KEY) !== "granted") return;
  const sink = (window as unknown as { __zapnivoAnalytics?: (e: string, p?: object) => void }).__zapnivoAnalytics;
  sink?.(event, props);
}
