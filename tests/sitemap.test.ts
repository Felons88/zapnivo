import { describe, expect, it, vi } from "vitest";

// Host simulation: next/headers is the only request-scoped dependency of the
// metadata routes, so a mutable holder lets each test pick the Host header.
const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.zapnivo.com";
  return { host: "www.zapnivo.com" };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: h.host }) }));

import sitemap from "@/app/sitemap";
import { SITE } from "@/lib/site";
import { PUBLIC_ARTICLES } from "@/lib/support-articles";

const MAIN_PATHS = [
  "/", "/how-it-works", "/locations", "/business", "/business/apply",
  "/about", "/contact", "/advertise",
  "/legal/privacy", "/legal/terms", "/legal/rental-terms",
  "/legal/refund-policy", "/legal/cookie-policy", "/legal/accessibility",
];
const PRIVATE_PREFIXES = ["/admin", "/partners", "/account", "/api", "/login", "/r", "/support"];

const entries = async () => {
  h.host = "www.zapnivo.com";
  return sitemap();
};

describe("sitemap — apex/marketing host", () => {
  it("runs against the production canonical host", () => {
    expect(SITE.url).toBe("https://www.zapnivo.com");
  });

  it("lists every indexable public page as an absolute https URL", async () => {
    const map = await entries();
    expect(map).toHaveLength(MAIN_PATHS.length);
    const paths = map.map((e) => {
      const u = new URL(e.url);
      expect(u.protocol).toBe("https:");
      expect(u.host).toBe("www.zapnivo.com");
      return u.pathname;
    });
    expect(new Set(paths)).toEqual(new Set(MAIN_PATHS));
    for (const p of paths) {
      for (const priv of PRIVATE_PREFIXES) {
        expect(p === priv || p.startsWith(`${priv}/`)).toBe(false);
      }
    }
  });

  it("does not include portal or account paths", async () => {
    const urls = (await entries()).map((e) => e.url);
    for (const bad of ["/admin", "/partners", "/account", "/api/", "/login", "/r/", "/support"]) {
      expect(urls.some((u) => u.includes(bad))).toBe(false);
    }
  });
});

describe("sitemap — support host", () => {
  it("lists the help center and every public article on support.zapnivo.com", async () => {
    h.host = "support.zapnivo.com";
    const map = await sitemap();
    const urls = map.map((e) => new URL(e.url));
    expect(urls.length).toBe(1 + PUBLIC_ARTICLES.length);
    for (const u of urls) {
      expect(u.protocol).toBe("https:");
      expect(u.host).toBe("support.zapnivo.com");
    }
    const paths = urls.map((u) => u.pathname);
    expect(paths).toContain("/");
    for (const { slug } of PUBLIC_ARTICLES) expect(paths).toContain(`/articles/${slug}`);
  });
});

describe("sitemap — private hosts", () => {
  it.each(["internal.zapnivo.com", "partners.zapnivo.com", "customer.zapnivo.com", "api.zapnivo.com"])(
    "returns an empty sitemap on %s",
    async (host) => {
      h.host = host;
      expect(await sitemap()).toEqual([]);
    },
  );
});
