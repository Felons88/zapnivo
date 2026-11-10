import { test, expect } from "@playwright/test";
import { ADMIN_PAGES, PARTNER_PAGES, goTo } from "./helpers";

// Runs in the "devstore" project against `next dev` + HELPDESK_DEV_STORE=1 (synthetic users,
// JSON store in .data/). Supabase is still unconfigured, so pages must render honest empty states.

test.describe("dev-store role switcher", () => {
  test("/api/dev/as sets a cookie for known roles and rejects unknown ones", async ({ request }) => {
    const bad = await request.get("/api/dev/as?role=root", { maxRedirects: 0 });
    expect(bad.status()).toBe(400);
    const ok = await request.get("/api/dev/as?role=admin", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(ok.status());
    expect(ok.headers()["set-cookie"]).toContain("zapnivo_dev_as=admin");
  });

  test("open redirect via back= is ignored", async ({ request }) => {
    const res = await request.get("/api/dev/as?role=admin&back=//evil.example", { maxRedirects: 0 });
    expect(new URL(res.headers().location, "http://localhost").hostname).not.toBe("evil.example");
  });
});

test.describe("admin pages render for the dev admin", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "zapnivo_dev_as", value: "admin", url: baseURL! }]);
  });
  for (const path of ADMIN_PAGES) {
    test(`${path}`, async ({ page }) => {
      const res = await goTo(page, path);
      expect(res?.status(), "status").toBe(200);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByText(/Application error: a (server|client)-side exception|Internal Server Error/i)).toHaveCount(0);
    });
  }
});

test.describe("partner pages render for the dev partner", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "zapnivo_dev_as", value: "partner", url: baseURL! }]);
  });
  for (const path of PARTNER_PAGES) {
    test(`${path}`, async ({ page }) => {
      const res = await goTo(page, path);
      expect(res?.status(), "status").toBe(200);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByText(/Application error: a (server|client)-side exception|Internal Server Error/i)).toHaveCount(0);
    });
  }

  test("partner cannot open admin pages", async ({ page }) => {
    await goTo(page, "/admin/users");
    await expect(page).not.toHaveURL(/\/admin\/users$/);
  });
});
