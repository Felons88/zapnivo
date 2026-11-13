import { z } from "zod";
import type { PublishedContent } from "../site-content";

/**
 * Newsletter pipeline — pure core (client-safe: no server-only imports).
 * DB/email orchestration lives in ./service.ts (server-only).
 */

export const NEWSLETTER_SEGMENTS = ["customer", "business", "both"] as const;
export type NewsletterSegment = (typeof NEWSLETTER_SEGMENTS)[number];

export const NEWSLETTER_STATUSES = ["pending", "confirmed", "unsubscribed"] as const;
export type NewsletterStatus = (typeof NEWSLETTER_STATUSES)[number];

/** Consent copy shown next to the subscribe checkbox. Bump VERSION when the text changes. */
export const NEWSLETTER_CONSENT_TEXT =
  "I agree to receive email updates from Zapnivo and understand I can unsubscribe at any time.";
export const NEWSLETTER_CONSENT_VERSION = "newsletter-consent-v1";

/* ── Subscribe schema (public endpoint) ────────────────────────────────────── */

const email = z.string().trim().toLowerCase().email().max(254);
const honeypot = z.string().max(0).optional();

/** Segment the visitor picked in the popup — 'both' is only ever produced by merging. */
export const newsletterSubscribeSchema = z.object({
  email,
  segment: z.enum(["customer", "business"]),
  consent: z.literal(true, { message: "Consent is required to subscribe" }),
  source: z.string().trim().max(60).optional(),
  website: honeypot,
});
export type NewsletterSubscribeInput = z.infer<typeof newsletterSubscribeSchema>;

/* ── Dedup / lifecycle decisions (pure — unit tested) ───────────────────────── */

export type SubscriberState = { status: NewsletterStatus; segment: NewsletterSegment };
export type SubscribeAction = "create" | "resend_pending" | "merge_confirmed" | "resubscribe";

/** customer + business = both; identical segments stay as-is; 'both' absorbs everything. */
export function mergeSegments(a: NewsletterSegment, b: NewsletterSegment): NewsletterSegment {
  if (a === b) return a;
  if (a === "both" || b === "both") return "both";
  return "both"; // customer + business
}

/**
 * What a subscribe attempt should do, given the existing row (null = new email).
 *  - create:            new pending row + DOI email
 *  - resend_pending:    rotate confirm token + resend DOI (segment merged)
 *  - merge_confirmed:   confirmed subscriber re-submits → merge segment only, NO email
 *  - resubscribe:       previously unsubscribed → new pending cycle (fresh tokens, fresh
 *                       consent timestamp, DOI resent). Documented choice: an explicit
 *                       form re-submit is treated as a fresh opt-in request.
 */
export function decideSubscribe(existing: SubscriberState | null, incoming: NewsletterSegment): {
  action: SubscribeAction;
  segment: NewsletterSegment;
} {
  if (!existing) return { action: "create", segment: incoming };
  switch (existing.status) {
    case "pending":
      return { action: "resend_pending", segment: mergeSegments(existing.segment, incoming) };
    case "confirmed":
      return { action: "merge_confirmed", segment: mergeSegments(existing.segment, incoming) };
    case "unsubscribed":
      return { action: "resubscribe", segment: mergeSegments(existing.segment, incoming) };
  }
}

/* ── Popup config (CMS-driven, defaults below) ──────────────────────────────── */

export type NewsletterPopupConfig = {
  enabled: boolean;
  headline: string;
  description: string;
  ctaCustomer: string;
  ctaBusiness: string;
  image: string;
  delaySeconds: number;
  frequencyCapDays: number;
  excludedRoutes: string[];
  successMessage: string;
  businessCtaHref: string;
};

/**
 * Routes where the popup must never appear: checkout/payment, auth, account,
 * portal and application flows. Matched on path-segment boundaries.
 */
export const DEFAULT_EXCLUDED_ROUTES = [
  "/checkout",
  "/r",
  "/login",
  "/account",
  "/advertiser",
  "/partners",
  "/admin",
  "/system",
] as const;

export const DEFAULT_NEWSLETTER_CONFIG: NewsletterPopupConfig = {
  enabled: true,
  headline: "Never Run Out of Power.",
  description:
    "Get occasional Zapnivo updates — new station locations, rental tips, and product news. No spam, unsubscribe anytime.",
  ctaCustomer: "Email me updates",
  ctaBusiness: "Partner with Zapnivo",
  image: "",
  delaySeconds: 8,
  frequencyCapDays: 14,
  excludedRoutes: [...DEFAULT_EXCLUDED_ROUTES],
  successMessage: "You're on the list — check your inbox to confirm your subscription.",
  businessCtaHref: "/business/apply",
};

const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * Resolves popup config from published CMS content (apex / "newsletter" page).
 * Every field falls back to DEFAULT_NEWSLETTER_CONFIG — the popup works with
 * zero CMS rows. `excluded_routes` is a comma-separated string field.
 */
export function newsletterConfigFromContent(content: PublishedContent): NewsletterPopupConfig {
  const d = DEFAULT_NEWSLETTER_CONFIG;
  const routesRaw = content["excluded_routes"];
  const routes =
    typeof routesRaw === "string" && routesRaw.trim() !== ""
      ? routesRaw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30)
      : d.excludedRoutes;
  return {
    enabled: typeof content["enabled"] === "boolean" ? content["enabled"] : d.enabled,
    headline: typeof content["headline"] === "string" && content["headline"].trim() ? content["headline"].trim() : d.headline,
    description: typeof content["description"] === "string" && content["description"].trim() ? content["description"].trim() : d.description,
    ctaCustomer: typeof content["cta_customer"] === "string" && content["cta_customer"].trim() ? content["cta_customer"].trim() : d.ctaCustomer,
    ctaBusiness: typeof content["cta_business"] === "string" && content["cta_business"].trim() ? content["cta_business"].trim() : d.ctaBusiness,
    image: typeof content["image"] === "string" ? content["image"].trim() : d.image,
    delaySeconds: clampInt(content["delay_seconds"], d.delaySeconds, 0, 120),
    frequencyCapDays: clampInt(content["frequency_cap_days"], d.frequencyCapDays, 1, 365),
    excludedRoutes: routes,
    successMessage: typeof content["success_message"] === "string" && content["success_message"].trim() ? content["success_message"].trim() : d.successMessage,
    businessCtaHref: typeof content["business_cta_href"] === "string" && content["business_cta_href"].trim() ? content["business_cta_href"].trim() : d.businessCtaHref,
  };
}

/* ── Operator test-send allowlist (pure — unit tested) ──────────────────────── */

/**
 * Addresses the System Control "send test DOI" workflow may target.
 *
 * Allowed when EITHER:
 *  - the address is explicitly listed in NEWSLETTER_TEST_ADDRESSES
 *    (comma-separated, case-insensitive), OR
 *  - it sits on the company domain *@zapnivo.com.
 *
 * Rationale: DOI test emails carry a live confirm link, so they must never be
 * pointed at real customers. The default domain rule covers staff mailboxes
 * without extra env config; the env list exists for staging/test inboxes on
 * other domains. Anything else is rejected before a subscriber row is created.
 */
export const NEWSLETTER_TEST_DOMAIN = "zapnivo.com";

export function newsletterTestAddressesFromEnv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

export function isNewsletterTestAddressAllowed(email: string, envList?: string): boolean {
  const addr = email.trim().toLowerCase();
  if (!addr) return false;
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  if (domain === NEWSLETTER_TEST_DOMAIN) return true;
  return newsletterTestAddressesFromEnv(envList ?? process.env.NEWSLETTER_TEST_ADDRESSES).includes(addr);
}

/** Path-segment-boundary match: "/account" excludes "/account/x" but not "/accounting". */
export function isExcludedRoute(pathname: string, excluded: readonly string[]): boolean {
  const path = pathname.split(/[?#]/)[0] || "/";
  return excluded.some((route) => {
    const r = route.trim();
    if (!r.startsWith("/")) return false;
    const base = r.endsWith("/") ? r.slice(0, -1) : r;
    if (base === "") return false;
    return path === base || path.startsWith(base + "/");
  });
}
