import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.zapnivo.com";
  return { host: "www.zapnivo.com" };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: h.host }) }));

import robots from "@/app/robots";
import { GET as llmsTxt } from "@/app/llms.txt/route";
import { GET as llmsFullTxt } from "@/app/llms-full.txt/route";
import { SITE } from "@/lib/site";

const read = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");

type Rule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };
const rulesOf = (r: { rules?: Rule | Rule[] }): Rule[] =>
  Array.isArray(r.rules) ? r.rules : r.rules ? [r.rules] : [];
const asList = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const starRule = (r: { rules?: Rule | Rule[] }) =>
  rulesOf(r).find((x) => asList(x.userAgent).includes("*"));
const disallows = (r: { rules?: Rule | Rule[] }) => asList(starRule(r)?.disallow);

describe("robots.txt — private portal hosts", () => {
  it.each(["internal.zapnivo.com", "partners.zapnivo.com", "customer.zapnivo.com", "api.zapnivo.com", "system.zapnivo.com"])(
    "disallows everything on %s",
    async (host) => {
      h.host = host;
      const r = await robots();
      const star = starRule(r);
      expect(asList(star?.disallow)).toContain("/");
      expect(rulesOf(r)).toHaveLength(1);
    },
  );
});

describe("robots.txt — support host", () => {
  it("allows public help content but blocks tickets and the ticket form", async () => {
    h.host = "support.zapnivo.com";
    const r = await robots();
    const star = starRule(r);
    expect(asList(star?.allow)).toContain("/");
    const d = disallows(r);
    for (const priv of ["/ticket", "/new", "/api", "/login", "/admin", "/partners"]) {
      expect(d).toContain(priv);
    }
    // Public indexable content must stay crawlable.
    expect(d).not.toContain("/articles");
    expect(d).not.toContain("/");
    expect(r.sitemap).toBe("https://support.zapnivo.com/sitemap.xml");
  });
});

describe("robots.txt — marketing host", () => {
  it("allows crawling, blocks private paths, and welcomes AI crawlers", async () => {
    h.host = "www.zapnivo.com";
    const r = await robots();
    const star = starRule(r);
    expect(asList(star?.allow)).toContain("/");
    const d = disallows(r);
    for (const priv of ["/admin", "/partners", "/login", "/api", "/account", "/r", "/support/ticket", "/support/new"]) {
      expect(d).toContain(priv);
    }
    // Rendering assets and public content must never be blocked.
    expect(d).not.toContain("/");
    expect(d.some((p) => p.includes(".css") || p.includes(".js") || p.startsWith("/_next"))).toBe(false);
    expect(r.sitemap).toBe(`${SITE.url}/sitemap.xml`);
    expect(r.host).toBe(SITE.url);
    // AI answer engines get the same public-content rules.
    const agents = rulesOf(r).flatMap((x) => asList(x.userAgent));
    for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
      expect(agents).toContain(bot);
    }
  });
});

describe("page metadata — static analysis", () => {
  const PUBLIC_PAGES = [
    "src/app/(site)/page.tsx",
    "src/app/(site)/how-it-works/page.tsx",
    "src/app/(site)/locations/page.tsx",
    "src/app/(site)/about/page.tsx",
    "src/app/(site)/contact/page.tsx",
    "src/app/(site)/advertise/page.tsx",
    "src/app/(site)/business/page.tsx",
    "src/app/(site)/business/apply/page.tsx",
    "src/app/(site)/legal/privacy/page.tsx",
    "src/app/(site)/legal/terms/page.tsx",
    "src/app/(site)/legal/rental-terms/page.tsx",
    "src/app/(site)/legal/refund-policy/page.tsx",
    "src/app/(site)/legal/cookie-policy/page.tsx",
    "src/app/(site)/legal/accessibility/page.tsx",
    "src/app/(site)/support/page.tsx",
    "src/app/(site)/support/articles/[slug]/page.tsx",
  ];
  it.each(PUBLIC_PAGES)("%s exports a title and description", (file) => {
    const src = read(file);
    expect(src).toMatch(/export (const metadata|async function generateMetadata|function generateMetadata)/);
    expect(src).toMatch(/title\s*:/);
    expect(src).toMatch(/description\s*:/);
  });

  const PRIVATE_PAGES = [
    "src/app/(site)/login/page.tsx",
    "src/app/(site)/account/page.tsx",
    "src/app/(site)/account/incident/page.tsx",
    "src/app/(site)/r/[station]/page.tsx",
    "src/app/(site)/support/new/page.tsx",
    "src/app/(site)/support/ticket/[number]/page.tsx",
    "src/app/not-found.tsx",
  ];
  it.each(PRIVATE_PAGES)("%s is marked noindex", (file) => {
    expect(read(file)).toMatch(/index:\s*false/);
  });

  it("root layout sets metadataBase, per-page canonical, OG and Twitter defaults", () => {
    const src = read("src/app/layout.tsx");
    expect(src).toContain("metadataBase");
    expect(src).toContain('canonical: "./"');
    expect(src).toContain("openGraph");
    expect(src).toContain("summary_large_image");
  });
});

describe("JSON-LD structured data", () => {
  it("root layout emits a valid Organization + WebSite @graph", () => {
    const src = read("src/app/layout.tsx");
    expect(src).toContain('type="application/ld+json"');
    const m = src.match(/const org = (\{[\s\S]*?\n\});/);
    expect(m).toBeTruthy();
    // Evaluate the literal with a stub SITE, then round-trip through JSON to prove validity.
    const org = new Function(
      "SITE",
      "subUrl",
      `return (${m![1]});`,
    )({ url: "https://www.zapnivo.com", name: "Zapnivo", tagline: "t", description: "d" }, (_s: string, p: string) => `https://support.zapnivo.com${p}`);
    const parsed = JSON.parse(JSON.stringify(org));
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(Array.isArray(parsed["@graph"])).toBe(true);
    const types = parsed["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    // Every URL in the graph must be absolute https on the canonical host.
    const urls: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        Object.entries(v).forEach(([k, val]) => {
          if (k !== "@context") walk(val);
        });
    };
    walk(parsed);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^https:\/\/[a-z.-]*zapnivo\.com/);
  });
});

describe("llms.txt routes", () => {
  it("llms.txt serves markdown pointing at canonical URLs", async () => {
    const res = llmsTxt();
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Zapnivo");
    expect(body).toContain(`${SITE.url}/how-it-works`);
    expect(body).toContain(`${SITE.url}/sitemap.xml`);
    expect(body).not.toContain("localhost");
  });

  it("llms-full.txt states confirmed pricing correctly", async () => {
    const res = llmsFullTxt();
    const body = await res.text();
    expect(body).toContain("# Zapnivo");
    expect(body).toContain("$6.99");
    expect(body).toContain("$45");
    expect(body).toContain("24-hour");
    // Regression: the old copy mislabeled the 24h hourly total as a "cap".
    expect(body).not.toContain("(cap)");
    expect(body).not.toContain("First 24 hours cap");
    expect(body).toContain("3 hours ≈ $20.97");
    expect(body).toContain("7 hours ≈ $48.93");
  });
});
