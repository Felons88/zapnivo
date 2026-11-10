import type { Page } from "@playwright/test";

/** Mirrors MAIN in src/app/sitemap.ts (apex host). */
export const PUBLIC_PATHS = [
  "/",
  "/how-it-works",
  "/locations",
  "/business",
  "/business/apply",
  "/about",
  "/contact",
  "/advertise",
  "/legal/privacy",
  "/legal/terms",
  "/legal/rental-terms",
  "/legal/refund-policy",
  "/legal/cookie-policy",
  "/legal/accessibility",
];

/** Other public pages that are not in the sitemap but must render. */
export const EXTRA_PATHS = ["/support", "/support/new", "/login"];

export const ADMIN_PAGES = [
  "/admin",
  "/admin/fleet",
  "/admin/users",
  "/admin/payouts",
  "/admin/rentals",
  "/admin/support",
  "/admin/audit",
  "/admin/inquiries",
  "/admin/partners",
  "/admin/onboarding",
  "/admin/advertising",
  "/admin/sla",
];

export const PARTNER_PAGES = [
  "/partners",
  "/partners/payouts",
  "/partners/settings",
  "/partners/documents",
  "/partners/support",
  "/partners/onboarding",
];

/** Port of the main (unconfigured-backend) server, used to build Host header overrides. */
export const MAIN_PORT = 3100;
export const hostFor = (sub: string) => `${sub}.localhost:${MAIN_PORT}`;

/**
 * Navigate waiting only for DOMContentLoaded: `load` can stall on on-demand image
 * optimization and lazy media, and nothing we assert needs it.
 */
export async function goTo(page: Page, path: string) {
  // Pre-decline the analytics consent banner so it can't cover controls.
  await page.addInitScript(() => localStorage.setItem("zapnivo_consent", "denied"));
  return page.goto(path, { waitUntil: "domcontentloaded" });
}

/** Dismiss the cookie/consent banner if it is showing so it cannot cover controls. */
export async function dismissConsent(page: Page) {
  const btn = page.getByRole("button", { name: /accept|got it|agree|reject|decline|essential/i }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
}
