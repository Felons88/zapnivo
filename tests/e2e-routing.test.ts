import { describe, expect, it } from "vitest";
import { apexCookieDomain, planRoute } from "@/lib/subdomains";

/**
 * E2E-routing edge cases for planRoute() that tests/subdomains.test.ts does not cover:
 * stray *.zapnivo.com canonicalization, customer-subdomain cross-portal bounces,
 * api.* rewrite coverage, auth-code fallback boundaries, custom BASE_DOMAIN, ports.
 */
const r = (host: string, path: string, protocol = "https:", base = "zapnivo.com") =>
  planRoute({ host, path, protocol, base });
const withCode = (host: string, path: string) =>
  planRoute({ host, path, protocol: "https:", base: "zapnivo.com", hasAuthCode: true });

describe("stray *.zapnivo.com hosts canonicalize to the apex", () => {
  it("redirects any unrecognized subdomain to the bare apex, preserving the path", () => {
    expect(r("foo.zapnivo.com", "/")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/" });
    expect(r("foo.zapnivo.com", "/support/new")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/support/new" });
    expect(r("staging.zapnivo.com", "/admin/fleet")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/admin/fleet" });
    // Deep/unknown paths are preserved verbatim — never rendered on the stray host.
    expect(r("foo.zapnivo.com", "/some/page")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/some/page" });
  });

  it("does not treat lookalike hosts as stray (www/apex DO redirect — to the subdomain)", () => {
    for (const host of ["zapnivo.com.evil.com", "notzapnivo.com", "evil-zapnivo.com", "zapnivo.com.evil-zapnivo.com"]) {
      expect(r(host, "/support"), host).toEqual({ kind: "next" });
    }
    // www and apex are explicitly canonical — /support redirects to the support subdomain.
    expect(r("www.zapnivo.com", "/support")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/" });
    expect(r("zapnivo.com", "/support")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/" });
  });

  it("stray redirect keeps the request protocol (http in local prod-mirror, https in prod)", () => {
    expect(r("foo.zapnivo.com", "/about", "http:")).toEqual({ kind: "redirect", to: "http://www.zapnivo.com/about" });
  });

  it("unknown *.localhost hosts are local apex traffic, not stray domains", () => {
    expect(r("foo.localhost:3000", "/admin", "http:")).toEqual({ kind: "next" });
    expect(r("foo.localhost:3000", "/", "http:")).toEqual({ kind: "next" });
    expect(r("localhost:3000", "/account", "http:")).toEqual({ kind: "next" });
    expect(r("127.0.0.1:3000", "/partners", "http:")).toEqual({ kind: "next" });
  });
});

describe("customer.* subdomain edges", () => {
  it("bounces every other portal's paths to the owning subdomain", () => {
    expect(r("customer.zapnivo.com", "/admin")).toEqual({ kind: "redirect", to: "https://internal.zapnivo.com/" });
    expect(r("customer.zapnivo.com", "/partners/payouts")).toEqual({ kind: "redirect", to: "https://partners.zapnivo.com/payouts" });
    expect(r("customer.zapnivo.com", "/support/new")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/new" });
    // internal keeps its own /admin/support helpdesk prefix — customer must not steal it either way.
    expect(r("customer.zapnivo.com", "/admin/support/metrics").kind).toBe("redirect");
  });

  it("rewrites account sub-paths under /account with noindex", () => {
    expect(r("customer.zapnivo.com", "/rentals")).toEqual({ kind: "rewrite", to: "/account/rentals", noindex: true });
    expect(r("customer.zapnivo.com", "/rentals/R-123/history")).toEqual({ kind: "rewrite", to: "/account/rentals/R-123/history", noindex: true });
    expect(r("customer.zapnivo.com", "/settings")).toEqual({ kind: "rewrite", to: "/account/settings", noindex: true });
    expect(r("customer.zapnivo.com", "/incident/abc")).toEqual({ kind: "rewrite", to: "/account/incident/abc", noindex: true });
  });

  it("bounces apex-owned marketing sections back to the apex", () => {
    expect(r("customer.zapnivo.com", "/legal/privacy")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/legal/privacy" });
    expect(r("customer.zapnivo.com", "/r/REF123")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/r/REF123" });
    // …but files pass through untouched (llms.txt is served on every host).
    expect(r("customer.zapnivo.com", "/llms.txt")).toEqual({ kind: "next", noindex: true });
  });

  it("passes through /login, /api and files — all noindex", () => {
    for (const p of ["/login", "/api/account/export", "/api/auth/callback", "/favicon.ico", "/.well-known/security.txt"]) {
      expect(r("customer.zapnivo.com", p), p).toEqual({ kind: "next", noindex: true });
    }
  });
});

describe("api.* subdomain edges", () => {
  it("rewrites arbitrary paths under /api with noindex", () => {
    expect(r("api.zapnivo.com", "/admin/export")).toEqual({ kind: "rewrite", to: "/api/admin/export", noindex: true });
    expect(r("api.zapnivo.com", "/account/preferences")).toEqual({ kind: "rewrite", to: "/api/account/preferences", noindex: true });
    expect(r("api.zapnivo.com", "/support/tickets")).toEqual({ kind: "rewrite", to: "/api/support/tickets", noindex: true });
    expect(r("api.zapnivo.com", "/deep/nested/path")).toEqual({ kind: "rewrite", to: "/api/deep/nested/path", noindex: true });
  });

  it("leaves /api/* untouched and noindexes everything", () => {
    expect(r("api.zapnivo.com", "/api/admin/export")).toEqual({ kind: "next", noindex: true });
    // On api.* every non-/api path rewrites under /api — including /login.
    expect(r("api.zapnivo.com", "/login")).toEqual({ kind: "rewrite", to: "/api/login", noindex: true });
  });
});

describe("apex canonical redirect boundaries", () => {
  it("requires an exact segment boundary — /supportx is not /support", () => {
    // www is the serving apex host; the bare apex would 308 to www first.
    expect(r("www.zapnivo.com", "/supportx")).toEqual({ kind: "next" });
    expect(r("www.zapnivo.com", "/administer")).toEqual({ kind: "next" });
    expect(r("www.zapnivo.com", "/partners-foo")).toEqual({ kind: "next" });
  });

  it("handles trailing slashes and deep account paths", () => {
    expect(r("zapnivo.com", "/support/")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/" });
    expect(r("zapnivo.com", "/account/settings/privacy")).toEqual({ kind: "redirect", to: "https://customer.zapnivo.com/settings/privacy" });
  });

  it("/r referral links stay on the apex (they are marketing, not a portal)", () => {
    // Bare apex canonicalizes to www; www serves the page directly.
    expect(r("zapnivo.com", "/r/ABC123")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/r/ABC123" });
    expect(r("www.zapnivo.com", "/r/ABC123")).toEqual({ kind: "next" });
    // …but a subdomain bounces them back to the canonical apex.
    expect(r("support.zapnivo.com", "/r/ABC123")).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/r/ABC123" });
  });
});

describe("OAuth ?code fallback boundaries", () => {
  it("only fires on the root path — deep links and prefixed paths are untouched", () => {
    expect(withCode("www.zapnivo.com", "/about")).toEqual({ kind: "next" });
    expect(withCode("zapnivo.com", "/support/new")).toEqual({ kind: "redirect", to: "https://support.zapnivo.com/new" });
    expect(withCode("support.zapnivo.com", "/new")).toEqual({ kind: "rewrite", to: "/support/new", noindex: false });
    expect(withCode("api.zapnivo.com", "/")).toEqual({ kind: "rewrite", to: "/api/auth/callback" });
    expect(withCode("customer.zapnivo.com", "")).toEqual({ kind: "rewrite", to: "/api/auth/callback" });
  });
});

describe("ports and custom base domains", () => {
  it("strips ports when matching subdomains but keeps them for local apex/sub hosts", () => {
    expect(r("internal.zapnivo.com:8443", "/")).toEqual({ kind: "rewrite", to: "/admin", noindex: true });
    expect(r("support.localhost:3100", "/", "http:")).toEqual({ kind: "rewrite", to: "/support", noindex: false });
    // Canonical redirects on non-local hosts ignore the port (real DNS has none).
    const d = r("foo.zapnivo.com:443", "/x");
    expect(d).toEqual({ kind: "redirect", to: "https://www.zapnivo.com/x" });
  });

  it("honours a custom BASE_DOMAIN for sub + stray detection", () => {
    const b = "staging.example.com";
    expect(r(`support.${b}`, "/", "https:", b)).toEqual({ kind: "rewrite", to: "/support", noindex: false });
    expect(r(`internal.${b}`, "/", "https:", b)).toEqual({ kind: "rewrite", to: "/admin", noindex: true });
    expect(r(`foo.${b}`, "/support", "https:", b)).toEqual({ kind: "redirect", to: `https://${b}/support` });
    // zapnivo.com is not under the custom base, so it is neither a known sub nor "stray" — it falls through.
    expect(r("support.zapnivo.com", "/", "https:", b).kind).not.toBe("rewrite");
  });
});

describe("apexCookieDomain", () => {
  it("shares cookies across *.zapnivo.com but never on local or lookalike hosts", () => {
    expect(apexCookieDomain("zapnivo.com")).toBe("zapnivo.com");
    expect(apexCookieDomain("www.zapnivo.com")).toBe("zapnivo.com");
    expect(apexCookieDomain("internal.zapnivo.com:443")).toBe("zapnivo.com");
    expect(apexCookieDomain("localhost:3000")).toBeUndefined();
    expect(apexCookieDomain("support.localhost")).toBeUndefined();
    expect(apexCookieDomain("zapnivo.com.evil.com")).toBeUndefined();
    expect(apexCookieDomain("notzapnivo.com")).toBeUndefined();
  });
});
