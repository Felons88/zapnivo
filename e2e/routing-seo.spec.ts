import { test, expect } from "@playwright/test";
import { PUBLIC_PATHS, goTo, hostFor } from "./helpers";

/**
 * Host-header routing on the apex production domain + robots/sitemap contracts +
 * portal noindex + map fallback + customer-account auth boundaries.
 *
 * The e2e server runs on localhost, where planRoute intentionally does NOT canonicalize
 * portal paths — so apex redirect tests spoof `Host: zapnivo.com` / `www.zapnivo.com`,
 * exactly like subdomains.spec.ts spoofs `*.localhost`.
 */
const APEX = "zapnivo.com:3100";
const WWW = "www.zapnivo.com:3100";
const apex = (path: string, host = APEX) => ({ headers: { host }, maxRedirects: 0 });
const sub = (s: string) => ({ headers: { host: hostFor(s) }, maxRedirects: 0 });

test.describe("apex canonical redirects (Host: zapnivo.com)", () => {
  const cases: [string, string, string][] = [
    ["/support", "support.zapnivo.com", "/"],
    ["/support/new", "support.zapnivo.com", "/new"],
    ["/support/articles/how-to-rent-a-charger", "support.zapnivo.com", "/articles/how-to-rent-a-charger"],
    ["/admin", "internal.zapnivo.com", "/"],
    ["/admin/fleet", "internal.zapnivo.com", "/fleet"],
    ["/partners", "partners.zapnivo.com", "/"],
    ["/partners/payouts", "partners.zapnivo.com", "/payouts"],
    ["/account", "customer.zapnivo.com", "/"],
    ["/account/rentals", "customer.zapnivo.com", "/rentals"],
  ];
  for (const [path, host, to] of cases) {
    test(`${path} → ${host}${to}`, async ({ request }) => {
      const res = await request.get(path, apex(path));
      expect(res.status()).toBe(308);
      const loc = new URL(res.headers().location);
      expect(loc.hostname).toBe(host);
      expect(loc.pathname).toBe(to);
    });
  }

  test("www.zapnivo.com redirects the same way", async ({ request }) => {
    const res = await request.get("/partners/documents", { headers: { host: WWW }, maxRedirects: 0 });
    expect(res.status()).toBe(308);
    const loc = new URL(res.headers().location);
    expect(loc.hostname).toBe("partners.zapnivo.com");
    expect(loc.pathname).toBe("/documents");
  });

  test("query string survives the canonical redirect", async ({ request }) => {
    const res = await request.get("/support/new?ref=nav&x=1", apex("/support/new"));
    expect(res.status()).toBe(308);
    const loc = new URL(res.headers().location);
    expect(loc.hostname).toBe("support.zapnivo.com");
    expect(loc.search).toContain("ref=nav");
  });

  test("marketing paths on the apex host are not redirected", async ({ request }) => {
    for (const path of ["/", "/about", "/locations", "/business", "/contact", "/legal/privacy", "/login"]) {
      const res = await request.get(path, apex(path));
      expect(res.status(), path).toBe(200);
    }
  });

  test("prefix lookalikes do not redirect (/supportx stays put)", async ({ request }) => {
    const res = await request.get("/supportx", apex("/supportx"));
    // Not a portal path → falls through to normal routing (404 is fine, must NOT 308 to a subdomain).
    expect(res.status()).not.toBe(308);
    if (res.status() === 200) expect(res.headers().location).toBeUndefined();
  });
});

test.describe("stray and unknown hosts", () => {
  test("unknown *.zapnivo.com host bounces to the apex, keeping the path", async ({ request }) => {
    for (const path of ["/", "/support", "/admin/fleet", "/some/page"]) {
      const res = await request.get(path, { headers: { host: `foo.zapnivo.com:3100` }, maxRedirects: 0 });
      expect(res.status(), path).toBe(308);
      const loc = new URL(res.headers().location);
      expect(loc.hostname).toBe("zapnivo.com");
      expect(loc.pathname).toBe(path);
    }
  });

  test("portal paths never render on a stray subdomain", async ({ request }) => {
    const res = await request.get("/admin", { headers: { host: "typo.zapnivo.com:3100" }, maxRedirects: 0 });
    expect(res.status()).toBe(308);
    // First hop is the apex path — the apex then canonicalizes to internal.*; never portal HTML here.
    expect(new URL(res.headers().location).pathname).toBe("/admin");
    expect(await res.text()).not.toMatch(/Console|Dashboard/);
  });

  test("lookalike domains are not treated as zapnivo.com", async ({ request }) => {
    for (const host of ["zapnivo.com.evil.com:3100", "notzapnivo.com:3100"]) {
      const res = await request.get("/admin", { headers: { host }, maxRedirects: 0 });
      expect(res.status(), host).not.toBe(308);
    }
  });

  test("unknown *.localhost behaves like the apex (no canonical redirect)", async ({ request }) => {
    const res = await request.get("/", { headers: { host: "foo.localhost:3100" }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(/<h1/);
  });
});

test.describe("robots.txt and sitemap.xml contracts", () => {
  test("apex robots.txt: 200, text/plain, disallows private paths, points at sitemap", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/User-agent: \*/i);
    expect(body).toMatch(/Allow: \//);
    for (const p of ["/admin", "/partners", "/account", "/api", "/login", "/r", "/support/ticket"]) {
      expect(body, `missing Disallow: ${p}`).toContain(`Disallow: ${p}`);
    }
    expect(body).toMatch(/Sitemap:.*sitemap\.xml/);
  });

  test("apex robots.txt welcomes AI crawlers on public content only", async ({ request }) => {
    const body = await (await request.get("/robots.txt")).text();
    expect(body).toMatch(/GPTBot/);
    expect(body).toMatch(/ClaudeBot/);
  });

  test("sitemap.xml: 200, xml content-type, public URLs only", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/xml/);
    const body = await res.text();
    expect(body).toContain("<loc>");
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname.replace(/\/$/, "") || "/");
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(PUBLIC_PATHS, loc).toContain(loc);
      for (const p of ["/admin", "/account", "/api", "/r", "/login", "/partners"]) {
        expect(loc === p || loc.startsWith(`${p}/`), `sitemap must not list ${loc}`).toBe(false);
      }
    }
  });

  test("support.* sitemap lists the help center + articles, not portals", async ({ request }) => {
    const res = await request.get("/sitemap.xml", sub("support"));
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain("<loc>");
    expect(body).toContain("/articles/");
    for (const p of ["/admin", "/account", "/api/"]) expect(body).not.toContain(p);
  });
});

test.describe("portal gating: customer account", () => {
  test("customer.* root never leaks account data when signed out", async ({ request }) => {
    const res = await request.get("/", sub("customer"));
    if ([301, 302, 303, 307, 308].includes(res.status())) {
      expect(res.headers().location).toMatch(/\/login/);
    } else {
      expect(res.status()).toBe(200);
      expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
      const html = await res.text();
      expect(html).not.toMatch(/Sign out|Your rentals|Rental history/i);
    }
  });

  test("apex /account redirects signed-out visitors to /login", async ({ request }) => {
    const res = await request.get("/account", { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(res.status());
    expect(res.headers().location).toMatch(/\/login/);
  });

  test("portal pages carry noindex metadata", async ({ request }) => {
    for (const path of ["/admin", "/partners", "/login"]) {
      const res = await request.get(path);
      const html = await res.text();
      const meta = /<meta[^>]+name="robots"[^>]*>/i.exec(html)?.[0] ?? "";
      expect(meta, `${path} robots meta`).toMatch(/noindex/i);
    }
  });
});

test.describe("public pages: SSR content sanity", () => {
  test("every public page ships an h1 and substantial server-rendered text", async ({ request }) => {
    for (const path of PUBLIC_PATHS) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, `${path} missing <h1`).toMatch(/<h1[\s>]/);
      const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      expect(text.length, `${path} thin SSR content`).toBeGreaterThan(400);
    }
  });

  test("stable landmarks survive copy changes", async ({ request }) => {
    const locations = await (await request.get("/locations")).text();
    expect(locations).toMatch(/Minnesota/i);
    const home = await (await request.get("/")).text();
    expect(home).toMatch(/Zapnivo/);
  });
});

test.describe("map fallback without NEXT_PUBLIC_MAPBOX_TOKEN", () => {
  test("/locations renders the honest fallback, never a broken map or env-var leak", async ({ request, page }) => {
    const mapboxRequests: string[] = [];
    page.on("request", (r) => {
      if (/mapbox/i.test(r.url())) mapboxRequests.push(r.url());
    });
    const res = await request.get("/locations");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("NEXT_PUBLIC_MAPBOX_TOKEN");
    expect(html).not.toMatch(/access_token=pk\./); // no token value baked into markup

    await goTo(page, "/locations");
    // SSR + hydrated fallback copy (NetworkMap renders it immediately when the token is unset).
    await expect(page.getByText(/coming soon|temporarily unavailable/i).first()).toBeVisible();
    // Locator search must degrade honestly, not call Mapbox.
    const finder = page.locator("form", { has: page.locator("#station-search") });
    const input = finder.locator("#station-search");
    // Give React time to hydrate before the first click: a pre-hydration submit natively
    // reloads the page (the input has no `name`, so the GET is a no-op) and resets the clock.
    await page.waitForLoadState("load");
    await page.waitForTimeout(2500);
    const searchMsg = page.getByRole("status").filter({ hasText: /temporarily unavailable/i });
    for (let i = 0; i < 10 && !(await searchMsg.first().isVisible().catch(() => false)); i++) {
      await input.fill("Minneapolis");
      await finder.getByRole("button", { name: "Search", exact: true }).click();
      await page.waitForTimeout(500);
    }
    await expect(searchMsg.first()).toBeVisible();
    expect(mapboxRequests).toEqual([]);
  });

  test("homepage station section uses the same fallback", async ({ request }) => {
    const html = await (await request.get("/")).text();
    expect(html).not.toContain("NEXT_PUBLIC_MAPBOX_TOKEN");
    expect(html).toMatch(/coming soon|temporarily unavailable|Find power near you/i);
  });
});

test.describe("auth boundaries: customer account APIs", () => {
  test("GET /api/account/export rejects anonymous callers", async ({ request }) => {
    const res = await request.get("/api/account/export", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
  });

  test("POST /api/account/preferences rejects anonymous callers", async ({ request }) => {
    const res = await request.post("/api/account/preferences", { data: { notify_sms: true } });
    expect(res.status()).toBe(401);
  });

  test("POST /api/account/delete-request rejects anonymous callers", async ({ request }) => {
    const res = await request.post("/api/account/delete-request", { data: { confirm: true } });
    expect(res.status()).toBe(401);
  });
});
