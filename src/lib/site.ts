import { SUB_PREFIX, baseDomain, type Subdomain } from "./subdomains";
import { CONTACTS } from "./contacts";

export const SITE = {
  name: "Zapnivo",
  tagline: "Life moves. Power follows.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  description:
    "Zapnivo is a portable phone-charger rental network rolling out across Minnesota. Rent a power bank, stay connected, and return it to a participating station.",
};

/**
 * Absolute URL for something living on a portal subdomain. On the real domain it's
 * https://<sub>.zapnivo.com<path>; anywhere else (localhost, preview deploys) it's the
 * plain prefix path on the same origin so dev and previews keep working end to end.
 */
export function subUrl(sub: Subdomain, path = "/", baseUrl: string = SITE.url): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const prefix = sub === "api" ? "/api" : SUB_PREFIX[sub];
  let u: URL;
  try { u = new URL(baseUrl); } catch { return `${prefix}${clean === "/" ? "" : clean}`; }
  const base = baseDomain();
  const apex = u.hostname === base || u.hostname === `www.${base}`;
  if (!apex) return `${baseUrl.replace(/\/$/, "")}${prefix}${clean === "/" ? "" : clean}`;
  return `${u.protocol}//${sub}.${base}${clean}`;
}

export const NAV = [
  { href: "/how-it-works", label: "How It Works" },
  { href: "/locations", label: "Find a Station" },
  { href: "/business", label: "For Businesses" },
  { href: "/about", label: "About" },
  { href: "/support", label: "Support" },
];

export const FOOTER = {
  Product: [
    { href: "/how-it-works", label: "How It Works" },
    { href: "/locations", label: "Find a Station" },
    { href: "/support", label: "Support" },
  ],
  Business: [
    { href: "/business", label: "For Businesses" },
    { href: "/business/apply", label: "Partner Application" },
    { href: "/advertise", label: "Advertise" },
  ],
  Company: [
    { href: "/about", label: "About" },
    { href: "/contact", label: "Contact" },
  ],
  "Contact Zapnivo": [
    { href: `mailto:${CONTACTS.general.email}`, label: CONTACTS.general.email },
    { href: "/scam-awareness", label: "Scam Awareness" },
    { href: "/legal/privacy", label: "Privacy Policy" },
    { href: "/legal/terms", label: "Terms of Service" },
    { href: "/support", label: "Support" },
    { href: "/business", label: "For Businesses" },
  ],
  Legal: [
    { href: "/legal/privacy", label: "Privacy Policy" },
    { href: "/legal/terms", label: "Terms of Service" },
    { href: "/legal/rental-terms", label: "Rental Terms" },
    { href: "/legal/refund-policy", label: "Refund Policy" },
    { href: "/legal/cookie-policy", label: "Cookie Policy" },
    { href: "/legal/accessibility", label: "Accessibility" },
  ],
};
