import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

const PRIVATE = ["/admin", "/partners", "/login", "/api", "/support/ticket"];

export default function robots(): MetadataRoute.Robots {
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
