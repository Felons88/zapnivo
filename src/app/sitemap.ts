import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { SITE, subUrl } from "@/lib/site";
import { baseDomain } from "@/lib/subdomains";
import { PUBLIC_ARTICLES } from "@/lib/support-articles";

export const dynamic = "force-dynamic";

const MAIN = [
  "", "/how-it-works", "/locations", "/business", "/business/apply",
  "/about", "/contact", "/advertise", "/legal/privacy", "/legal/terms",
  "/legal/rental-terms", "/legal/refund-policy", "/legal/cookie-policy",
  "/legal/accessibility",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = ((await headers()).get("host") ?? "").split(":")[0].toLowerCase();
  const base = baseDomain();
  const support = host === `support.${base}` || host === "support.localhost";
  const privateHost = ["customer", "internal", "partners", "api"].some(
    (sub) => host === `${sub}.${base}` || host === `${sub}.localhost`,
  );

  if (privateHost) return [];
  if (support) {
    return ["/", ...PUBLIC_ARTICLES.map(({ slug }) => `/articles/${slug}`)].map((path) => ({
      url: subUrl("support", path),
    }));
  }
  return MAIN.map((path) => ({ url: `${SITE.url.replace(/\/$/, "")}${path || "/"}` }));
}
