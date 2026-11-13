import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { SITE, subUrl } from "@/lib/site";
import { baseDomain } from "@/lib/subdomains";

export const dynamic = "force-dynamic";

const PRIVATE = ["/admin", "/partners", "/login", "/api", "/support/ticket", "/support/new", "/account", "/r"];
const SUPPORT_PRIVATE = ["/ticket", "/new", "/api", "/login", "/admin", "/partners", "/support/ticket", "/support/new"];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = ((await headers()).get("host") ?? "").split(":")[0].toLowerCase();
  const base = baseDomain();
  const is = (s: string) => host === `${s}.${base}` || host === `${s}.localhost`;

  // Private portals and the API host are not for crawlers at all.
  if (is("customer") || is("internal") || is("partners") || is("api") || is("system")) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }
  if (is("support")) {
    return {
      rules: [{ userAgent: "*", allow: "/", disallow: SUPPORT_PRIVATE }],
      sitemap: subUrl("support", "/sitemap.xml"),
    };
  }
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      // Explicitly welcome AI answer engines to the public content.
      { userAgent: ["GPTBot", "ChatGPT-User", "OAI-SearchBot"], allow: "/", disallow: PRIVATE },
      { userAgent: ["ClaudeBot", "Claude-User", "Claude-SearchBot"], allow: "/", disallow: PRIVATE },
      { userAgent: ["PerplexityBot", "Perplexity-User"], allow: "/", disallow: PRIVATE },
      { userAgent: ["Google-Extended", "Applebot-Extended", "meta-externalagent", "Bytespider"], allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
