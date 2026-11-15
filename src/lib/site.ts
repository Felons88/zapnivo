import { SUB_PREFIX, baseDomain, type Subdomain } from "./subdomains";
import { CONTACTS } from "./contacts";

export const SITE = {
  name: "Zapnivo",
  tagline: "Vending solutions for Minnesota businesses.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  description:
    "Zapnivo Vending Services provides vending solutions across Minnesota — snacks, beverages, food, phone charging, trading cards, and specialty machines — plus portable charger rentals.",
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
  { href: "/", label: "Home" },
  { href: "/vending/snacks", label: "Snack Vending" },
  { href: "/vending/drinks", label: "Beverage Vending" },
  { href: "/vending/phone-chargers", label: "Phone Charging" },
  { href: "/vending/trading-cards", label: "Trading Cards" },
  { href: "/locations", label: "Find a Charger" },
  { href: "/get-a-vending-machine", label: "Request a Machine" },
  { href: "/business", label: "For Businesses" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/support", label: "Support" },
];

export const FOOTER = {
  "Vending Solutions": [
    { href: "/vending/snacks", label: "Snack Vending" },
    { href: "/vending/drinks", label: "Beverage Vending" },
    { href: "/vending/food", label: "Food Vending" },
    { href: "/vending/phone-chargers", label: "Phone Charging" },
    { href: "/vending/trading-cards", label: "Trading Cards" },
    { href: "/vending/specialty", label: "Specialty Vending" },
  ],
  "For Businesses": [
    { href: "/get-a-vending-machine", label: "Request a Machine" },
    { href: "/business/apply", label: "Venue Partner" },
    { href: "/business", label: "How Placement Works" },
    { href: "/vending/locations", label: "Service Areas" },
    { href: "/advertise", label: "Advertise" },
  ],
  Company: [
    { href: "/about", label: "About" },
    { href: "/contact", label: "Contact" },
    { href: "/locations", label: "Find a Charger" },
    { href: "/how-it-works", label: "How Charging Works" },
    { href: "/support", label: "FAQs & Support" },
    { href: "/scam-awareness", label: "Scam Awareness" },
  ],
  "Contact Zapnivo": [
    { href: `mailto:${CONTACTS.general.email}`, label: CONTACTS.general.email },
    { href: "/legal/privacy", label: "Privacy Policy" },
    { href: "/legal/terms", label: "Terms of Service" },
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
