import { test, expect } from "@playwright/test";
import { EXTRA_PATHS, PUBLIC_PATHS, goTo } from "./helpers";

test.describe("public routes: status and SEO basics", () => {
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();

  for (const path of [...PUBLIC_PATHS, ...EXTRA_PATHS]) {
    // /login and /support/new are intentionally noindex (portal entry / transactional form).
    const indexable = !["/login", "/support/new"].includes(path);
    test(`${path}`, async ({ page, baseURL }) => {
      const res = await goTo(page, path);
      expect(res?.status(), "HTTP status").toBe(200);

      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).not.toHaveText(/^\s*$/);

      const title = (await page.title()).trim();
      expect(title.length, "title not empty").toBeGreaterThan(0);

      const desc = (await page.locator('meta[name="description"]').getAttribute("content", { timeout: 3000 }).catch(() => null))?.trim() ?? "";
      expect(desc.length, "meta description not empty").toBeGreaterThan(0);

      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href", { timeout: 3000 }).catch(() => null);
      expect(canonical, "canonical present").toBeTruthy();
      const cu = new URL(canonical!, baseURL);
      expect(cu.pathname.replace(/\/$/, "") || "/", "canonical self-references the page path").toBe(path);

      const robots = (await page.locator('meta[name="robots"]').getAttribute("content", { timeout: 1500 }).catch(() => null)) ?? "";
      const header = res!.headers()["x-robots-tag"] ?? "";
      if (indexable) {
        expect(robots).not.toMatch(/noindex/i);
        expect(header).not.toMatch(/noindex/i);
      }

      // Uniqueness across the whole run is checked per-worker below (and again in the sitemap spec).
      const dupT = titles.get(title);
      if (dupT && indexable) expect(dupT, `title "${title}" also used by ${dupT}`).toBe(path);
      titles.set(title, path);
      const dupD = descriptions.get(desc);
      if (dupD && indexable) expect(dupD, `description also used by ${dupD}`).toBe(path);
      descriptions.set(desc, path);
    });
  }
});

test("titles and descriptions are unique across all sitemap pages", async ({ request }) => {
  const seenT = new Map<string, string>();
  const seenD = new Map<string, string>();
  const clash: string[] = [];
  for (const path of PUBLIC_PATHS) {
    const html = await (await request.get(path)).text();
    const t = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    const d = /<meta[^>]+name="description"[^>]+content="([^"]*)"/i.exec(html)?.[1]?.trim() ?? "";
    if (seenT.has(t)) clash.push(`title "${t}": ${seenT.get(t)} vs ${path}`);
    if (seenD.has(d)) clash.push(`description: ${seenD.get(d)} vs ${path}`);
    seenT.set(t, path);
    seenD.set(d, path);
  }
  expect(clash, clash.join("\n")).toEqual([]);
});

test("sitemap.xml lists exactly the expected apex pages", async ({ request }) => {
  const res = await request.get("/sitemap.xml");
  expect(res.status()).toBe(200);
  const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname.replace(/\/$/, "") || "/");
  expect(locs.sort()).toEqual([...PUBLIC_PATHS].sort());
});

test.describe("legal pages render content", () => {
  for (const slug of ["privacy", "terms", "rental-terms", "refund-policy", "cookie-policy", "accessibility"]) {
    test(`/legal/${slug}`, async ({ page }) => {
      await goTo(page, `/legal/${slug}`);
      await expect(page.locator("h1")).toBeVisible();
      const text = (await page.locator("main").innerText()).length;
      expect(text).toBeGreaterThan(400);
    });
  }
});

test("unknown route returns 404", async ({ request }) => {
  const res = await request.get("/this-page-does-not-exist");
  expect(res.status()).toBe(404);
});
