import { test, expect } from "@playwright/test";
import { ADMIN_PAGES, PARTNER_PAGES, goTo } from "./helpers";

test.describe("security headers", () => {
  for (const path of ["/", "/contact", "/login", "/api/admin/export?type=rentals"]) {
    test(`headers on ${path}`, async ({ request }) => {
      const h = (await request.get(path, { maxRedirects: 0 })).headers();
      expect(h["content-security-policy"]).toContain("default-src 'self'");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["content-security-policy"]).toContain("object-src 'none'");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["permissions-policy"]).toBeTruthy();
      expect(h["x-powered-by"]).toBeUndefined();
    });
  }

  test("production CSP does not allow unsafe-eval", async ({ request }) => {
    test.skip(!!process.env.E2E_DEV, "dev server needs unsafe-eval");
    const csp = (await request.get("/")).headers()["content-security-policy"];
    expect(csp).not.toContain("unsafe-eval");
  });
});

test.describe("auth boundaries: portal pages", () => {
  // With auth configured, PortalGate/AdminGate does redirect("/login"). With the
  // unconfigured backend used here they render an honest "not configured" notice
  // instead — either way the gate must NOT show portal data to a stranger.
  for (const path of [...ADMIN_PAGES, ...PARTNER_PAGES]) {
    test(`${path}`, async ({ page }) => {
      await goTo(page, path);
      if (!page.url().match(/\/login(\?|$)/)) {
        await expect(page.getByText(/not configured|isn't connected|not connected/i).first()).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Console" })).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: "Portal" })).toHaveCount(0);
      }
    });
  }

  test("unconfigured /admin renders an honest notice, not portal data", async ({ page }) => {
    await goTo(page, "/admin");
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByText(/not configured|isn't connected|not connected/i).first()).toBeVisible();
  });

  test("portal pages are noindex", async ({ request }) => {
    const res = await request.get("/login");
    expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
  });
});

test.describe("auth boundaries: admin APIs", () => {
  test("POST /api/admin/fleet is 403", async ({ request }) => {
    const res = await request.post("/api/admin/fleet", { form: { action: "create_venue" }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
  test("POST /api/admin/users is 403", async ({ request }) => {
    const res = await request.post("/api/admin/users", { form: { action: "invite" }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
  test("POST /api/admin/payouts is 403", async ({ request }) => {
    const res = await request.post("/api/admin/payouts", { form: { action: "x" }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
  test("GET /api/admin/export?type=rentals is 403", async ({ request }) => {
    const res = await request.get("/api/admin/export?type=rentals", { maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
});

test.describe("device ingest and dev-only routes", () => {
  test("POST /api/devices/events is 503 without KIOSK_INGEST_SECRET", async ({ request }) => {
    const res = await request.post("/api/devices/events", {
      data: { station_id: "x", events: [{ type: "ping" }] },
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status()).toBe(503);
  });

  test("/api/dev/as is unavailable outside development", async ({ request }) => {
    test.skip(!!process.env.E2E_DEV, "main server runs in dev mode (E2E_DEV)");
    for (const role of ["admin", "partner"]) {
      const res = await request.get(`/api/dev/as?role=${role}`, { maxRedirects: 0 });
      expect(res.status()).toBe(404);
      expect(res.headers()["set-cookie"]).toBeUndefined();
    }
  });
});
