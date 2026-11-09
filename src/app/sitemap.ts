import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

const ROUTES: { path: string; freq: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }[] = [
  { path: "", freq: "weekly", priority: 1 },
  { path: "/how-it-works", freq: "weekly", priority: 0.9 },
  { path: "/locations", freq: "daily", priority: 0.9 },
  { path: "/business", freq: "weekly", priority: 0.8 },
  { path: "/business/apply", freq: "monthly", priority: 0.7 },
  { path: "/support", freq: "weekly", priority: 0.8 },
  { path: "/support/new", freq: "monthly", priority: 0.6 },
  { path: "/about", freq: "monthly", priority: 0.6 },
  { path: "/contact", freq: "monthly", priority: 0.6 },
  { path: "/advertise", freq: "monthly", priority: 0.5 },
  { path: "/legal/privacy", freq: "yearly", priority: 0.3 },
  { path: "/legal/terms", freq: "yearly", priority: 0.3 },
  { path: "/legal/rental-terms", freq: "yearly", priority: 0.4 },
  { path: "/legal/refund-policy", freq: "yearly", priority: 0.4 },
  { path: "/legal/cookie-policy", freq: "yearly", priority: 0.3 },
  { path: "/legal/accessibility", freq: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(({ path, freq, priority }) => ({ url: `${SITE.url}${path}`, lastModified: new Date(), changeFrequency: freq, priority }));
}
