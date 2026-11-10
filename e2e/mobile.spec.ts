import { test, expect } from "@playwright/test";
import { dismissConsent, goTo } from "./helpers";

// Runs only in the "mobile" project (390x844).
test.describe("mobile layout", () => {
  for (const path of ["/", "/how-it-works", "/business", "/locations", "/support", "/login"]) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      await goTo(page, path);
      await page.waitForTimeout(800);
      // Scroll through the page so lazy/reveal sections mount before measuring.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      });
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        bw: document.body.scrollWidth,
        iw: window.innerWidth,
      }));
      expect(m.iw).toBe(390);
      expect(m.sw, `documentElement.scrollWidth ${m.sw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
      expect(m.bw, `body.scrollWidth ${m.bw} > innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
    });
  }
});

test.describe("mobile navigation", () => {
  test("menu opens, links usable, Escape closes, focus visible", async ({ page }) => {
    await goTo(page, "/");
    await dismissConsent(page);
    const toggle = page.locator('button[aria-controls="mobile-menu"]');
    const menu = page.locator("#mobile-menu");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // The click can land before hydration finishes — retry until it takes effect.
    for (let i = 0; i < 10 && (await toggle.getAttribute("aria-expanded")) !== "true"; i++) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("aria-hidden", "false");
    const links = menu.locator("nav a[href]");
    await expect(links.first()).toBeVisible();
    expect(await links.count()).toBeGreaterThan(1);

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveAttribute("aria-hidden", "true");
  });

  test("toggle has an accessible name and a visible focus indicator", async ({ page }) => {
    await goTo(page, "/");
    const toggle = page.locator('button[aria-controls="mobile-menu"]');
    await expect(toggle).toHaveAccessibleName(/\S/);
    await toggle.focus();
    await expect(toggle).toBeFocused();
    const outline = await toggle.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow };
    });
    const visible = (outline.style !== "none" && outline.width > 0) || outline.shadow !== "none";
    expect(visible, `no focus indicator: ${JSON.stringify(outline)}`).toBe(true);
  });

  test("navigating from the menu works", async ({ page }) => {
    await goTo(page, "/");
    await dismissConsent(page);
    const toggle = page.locator('button[aria-controls="mobile-menu"]');
    for (let i = 0; i < 10 && (await toggle.getAttribute("aria-expanded")) !== "true"; i++) await toggle.click();
    await page.locator("#mobile-menu").getByRole("link", { name: /how it works/i }).first().click();
    await expect(page).toHaveURL(/\/how-it-works/);
    await expect(page.locator('button[aria-controls="mobile-menu"]')).toHaveAttribute("aria-expanded", "false");
  });
});
