import { describe, expect, it } from "vitest";
import { planRoute } from "@/lib/subdomains";
import { subUrl } from "@/lib/site";

const r = (host: string, path: string, protocol = "https:") => planRoute({ host, path, protocol, base: "zapnivo.com" });

describe("subdomain rewrites", () => {
  it("maps the support root and sub-paths onto /support", () => {
    expect(r("support.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/support", noindex: false });
    expect(r("support.zapnivo.com", "/new")).toEqual({ kind: "rewrite", to: "/support/new", noindex: false });
    expect(r("support.zapnivo.com", "/ticket/Z-1234")).toEqual({ kind: "rewrite", to: "/support/ticket/Z-1234", noindex: false });
    expect(r("support.zapnivo.com", "/articles/how-to-rent-a-charger")).toEqual({ kind: "rewrite", to: "/support/articles/how-to-rent-a-charger", noindex: false });
  });

  it("maps the internal and partners roots onto /admin and /partners with noindex", () => {
    expect(r("internal.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/admin", noindex: true });
    expect(r("internal.zapnivo.com", "/support/metrics")).toEqual({ kind: "rewrite", to: "/admin/support/metrics", noindex: true });
    expect(r("partners.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/partners", noindex: true });
    expect(r("partners.zapnivo.com", "/payouts")).toEqual({ kind: "rewrite", to: "/partners/payouts", noindex: true });
  });

  it("lets prefixed paths, /api, /login and files pass through on subdomains", () => {
    expect(r("internal.zapnivo.com", "/admin/support").kind).toBe("next");
    expect(r("support.zapnivo.com", "/support").kind).toBe("next");
    expect(r("support.zapnivo.com", "/api/support/tickets").kind).toBe("next");
    expect(r("internal.zapnivo.com", "/api/admin/helpdesk").kind).toBe("next");
    expect(r("internal.zapnivo.com", "/login").kind).toBe("next");
    expect(r("support.zapnivo.com", "/favicon.ico").kind).toBe("next");
    expect(r("support.zapnivo.com", "/robots.txt").kind).toBe("next");
  });

  it("rewrites api.zapnivo.com paths under /api", () => {
    expect(r("api.zapnivo.com", "/support/tickets")).toEqual({ kind: "rewrite", to: "/api/support/tickets", noindex: true });
    expect(r("api.zapnivo.com", "/api/support/tickets").kind).toBe("next");
    const root = r("api.zapnivo.com", "/");
    expect(root.kind).toBe("respond");
    if (root.kind === "respond") expect(root.status).toBe(200);
    const bots = r("api.zapnivo.com", "/robots.txt");
    expect(bots.kind).toBe("respond");
    if (bots.kind === "respond") expect(bots.body).toContain("Disallow: /");
  });

  it("maps the customer portal onto /account with noindex", () => {
    expect(r("customer.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/account", noindex: true });
    expect(r("customer.zapnivo.com", "/rentals")).toEqual({ kind: "rewrite", to: "/account/rentals", noindex: true });
    expect(r("customer.zapnivo.com", "/account")).toEqual({ kind: "next", noindex: true });
    expect(r("customer.zapnivo.com", "/api/auth/callback").kind).toBe("next");
    expect(r("customer.localhost:3000", "/", "http:")).toEqual({ kind: "rewrite", to: "/account", noindex: true });
  });

  it("bounces cross-portal and apex-owned paths to the right host", () => {
    expect(r("internal.zapnivo.com", "/partners/support")).toEqual({ kind: "redirect", to: "https://partners.zapnivo.com/support" });
    expect(r("support.zapnivo.com", "/admin")).toEqual({ kind: "redirect", to: "https://internal.zapnivo.com/" });
    expect(r("support.zapnivo.com", "/legal/refund-policy")).toEqual({ kind: "redirect", to: "https://zapnivo.com/legal/refund-policy" });
    expect(r("support.zapnivo.com", "/contact")).toEqual({ kind: "redirect", to: "https://zapnivo.com/contact" });
    expect(r("support.zapnivo.com", "/account")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/" });
    expect(r("internal.zapnivo.com", "/account/settings")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/settings" });
  });
});

describe("apex canonical redirects", () => {
  it("redirects portal sections to their subdomain, stripping the prefix", () => {
    expect(r("zapnivo.com", "/support")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/" });
    expect(r("zapnivo.com", "/support/new")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/new" });
    expect(r("www.zapnivo.com", "/admin/support")).toEqual({ kind: "redirect", to: "https://internal.zapnivo.com/support" });
    expect(r("zapnivo.com", "/partners/payouts")).toEqual({ kind: "redirect", to: "https://partners.zapnivo.com/payouts" });
    expect(r("zapnivo.com", "/account")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/" });
    expect(r("www.zapnivo.com", "/account/rentals")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/rentals" });
  });

  it("leaves marketing pages and /api on the apex untouched", () => {
    for (const p of ["/", "/about", "/locations", "/api/contact", "/api/support/tickets", "/login"]) {
      expect(r("zapnivo.com", p).kind).toBe("next");
    }
  });

  it("does not redirect on localhost or preview hosts", () => {
    for (const p of ["/support", "/admin", "/partners"]) {
      expect(r("localhost:3000", p, "http:").kind).toBe("next");
      expect(r("zapnivo-git-x.vercel.app", p).kind).toBe("next");
    }
  });
});

describe("oauth ?code fallback", () => {
  it("forwards a code dropped on the root to the auth callback", () => {
    expect(r("www.zapnivo.com", "/")).toEqual({ kind: "next" });
    expect(planRoute({ host: "www.zapnivo.com", path: "/", protocol: "https:", base: "zapnivo.com", hasAuthCode: true }))
      .toEqual({ kind: "rewrite", to: "/api/auth/callback" });
    expect(planRoute({ host: "internal.zapnivo.com", path: "/", protocol: "https:", base: "zapnivo.com", hasAuthCode: true }))
      .toEqual({ kind: "rewrite", to: "/api/auth/callback" });
  });
});

describe("local dev subdomains", () => {
  it("mirrors the production scheme on *.localhost, keeping the port", () => {
    expect(r("support.localhost:3000", "/", "http:")).toEqual({ kind: "rewrite", to: "/support", noindex: false });
    expect(r("internal.localhost:3000", "/partners", "http:")).toEqual({ kind: "redirect", to: "http://partners.localhost:3000/" });
    expect(r("support.localhost:3000", "/legal/terms", "http:")).toEqual({ kind: "redirect", to: "http://localhost:3000/legal/terms" });
  });
});

describe("subUrl", () => {
  it("produces subdomain URLs on the real domain and path URLs elsewhere", () => {
    expect(subUrl("support", "/ticket/Z-1?t=abc", "https://zapnivo.com")).toBe("https://support.zapnivo.com/ticket/Z-1?t=abc");
    expect(subUrl("partners", "/support/Z-1", "https://zapnivo.com")).toBe("https://partners.zapnivo.com/support/Z-1");
    expect(subUrl("support", "/ticket/Z-1", "http://localhost:3000")).toBe("http://localhost:3000/support/ticket/Z-1");
    expect(subUrl("support", "/ticket/Z-1", "https://zapnivo-git-x.vercel.app")).toBe("https://zapnivo-git-x.vercel.app/support/ticket/Z-1");
  });
});
