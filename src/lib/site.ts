export const SITE = {
  name: "Zapnivo",
  tagline: "Life moves. Power follows.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  description:
    "Zapnivo is a portable phone-charger rental network rolling out across Minnesota. Rent a power bank, stay connected, and return it to a participating station.",
};

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
  Legal: [
    { href: "/legal/privacy", label: "Privacy Policy" },
    { href: "/legal/terms", label: "Terms of Service" },
    { href: "/legal/rental-terms", label: "Rental Terms" },
    { href: "/legal/refund-policy", label: "Refund Policy" },
    { href: "/legal/cookie-policy", label: "Cookie Policy" },
    { href: "/legal/accessibility", label: "Accessibility" },
  ],
};
