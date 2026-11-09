import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

const PAGES = [
  "", "/how-it-works", "/locations", "/business", "/business/apply", "/support", "/support/new",
  "/about", "/contact", "/advertise",
  "/legal/privacy", "/legal/terms", "/legal/rental-terms", "/legal/refund-policy", "/legal/cookie-policy", "/legal/accessibility",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: `${SITE.url}${p}`, lastModified: new Date(), changeFrequency: "monthly", priority: p === "" ? 1 : p.startsWith("/legal") ? 0.3 : 0.7 }));
}
