import { test, expect } from "@playwright/test";
import { hostFor } from "./helpers";

// Host header overrides against the single local server (the proxy reads the Host header).
const as = (sub: string) => ({ headers: { host: hostFor(sub) }, maxRedirects: 0 });

test.describe("subdomain routing via Host header", () => {
  test("support.* serves the help center", async ({ request }) => {
    const res = await request.get("/", as("support"));
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<h1/);
    expect(html.toLowerCase()).toContain("support");
    expect(res.headers()["x-robots-tag"]).toBeUndefined();
  });

  test("support.* /new serves the ticket form", async ({ request }) => {
    const res = await request.get("/new", as("support"));
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Create ticket");
  });

  test("support.* bounces marketing sections to the apex", async ({ request }) => {
    const res = await request.get("/business", as("support"));
    expect(res.status()).toBe(308);
    expect(res.headers().location).toMatch(/\/business$/);
  });

  for (const sub of ["internal", "partners"]) {
    test(`${sub}.* root never leaks portal content`, async ({ request }) => {
      const res = await request.get("/", as(sub));
      expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
      // Auth configured → redirect to /login. Unconfigured (as here) → the rewritten
      // portal page renders its honest "not configured" notice instead. Never data.
      if ([302, 303, 307, 308].includes(res.status())) {
        expect(res.headers().location).toMatch(/\/login/);
      } else {
        expect(res.status()).toBe(200);
        expect(await res.text()).toMatch(/not configured|isn't connected|not connected/i);
      }
    });

    test(`${sub}.* /login is served and noindex`, async ({ request }) => {
      const res = await request.get("/login", as(sub));
      expect(res.status()).toBe(200);
      expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
    });
  }

  test("internal.* does not expose the other portal's paths", async ({ request }) => {
    const res = await request.get("/partners", as("internal"));
    expect(res.status()).toBe(308);
    expect(res.headers().location).toContain("partners.localhost");
  });

  test("api.* root returns the service document", async ({ request }) => {
    const res = await request.get("/", as("api"));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(await res.json()).toEqual({ service: "zapnivo-api", ok: true });
    expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
  });

  test("api.* rewrites paths onto /api/*", async ({ request }) => {
    const res = await request.get("/admin/export?type=rentals", as("api"));
    expect(res.status()).toBe(403);
  });

  test("robots.txt differs per host", async ({ request }) => {
    const get = async (sub?: string) => {
      const res = await request.get("/robots.txt", sub ? as(sub) : { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      return res.text();
    };
    const apex = await get();
    const support = await get("support");
    const customer = await get("customer");
    const internal = await get("internal");
    const partners = await get("partners");
    const api = await get("api");

    expect(apex).toMatch(/Allow: \//);
    expect(apex).toMatch(/Disallow: \/admin/);
    for (const body of [customer, internal, partners, api]) {
      expect(body).toMatch(/User-Agent: \*/i);
      expect(body).toMatch(/Disallow: \/\s*$/m);
      expect(body).not.toMatch(/Allow: \/\s*$/m);
    }
    expect(support).toMatch(/Allow: \//);
    expect(support).toMatch(/Disallow: \/ticket/);
    expect(new Set([apex, support, internal]).size).toBe(3);
  });

  test("sitemap is empty for private hosts", async ({ request }) => {
    for (const sub of ["customer", "internal", "partners", "api"]) {
      const res = await request.get("/sitemap.xml", as(sub));
      const body = await res.text();
      expect(body, sub).not.toContain("<loc>");
    }
  });
});
