import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { goTo } from "./helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { EXTRA_PATHS, PUBLIC_PATHS } from "./helpers";

const PAGES = [...PUBLIC_PATHS, ...EXTRA_PATHS];

test.describe("accessibility smoke", () => {
  for (const path of PAGES) {
    test(`images have alt and inputs have labels: ${path}`, async ({ page }) => {
      await goTo(page, path);
      await page.waitForTimeout(800);

      const noAlt = await page.evaluate(() =>
        [...document.querySelectorAll("img")]
          .filter((i) => !i.hasAttribute("alt"))
          .map((i) => i.currentSrc || i.src),
      );
      expect(noAlt, "images missing alt attribute").toEqual([]);

      const svgNoName = await page.evaluate(() =>
        [...document.querySelectorAll('svg[role="img"]')]
          .filter((s) => !s.getAttribute("aria-label") && !s.getAttribute("aria-labelledby") && !s.querySelector("title"))
          .length,
      );
      expect(svgNoName, 'svg[role="img"] without accessible name').toBe(0);

      const unlabeled = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement>("input, select, textarea")]
          .filter((el) => {
            if (el.type === "hidden" || el.type === "submit" || el.type === "button") return false;
            if (el.closest('[aria-hidden="true"]')) return false; // honeypot
            return !(el.labels && el.labels.length) && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby");
          })
          .map((el) => `${el.tagName.toLowerCase()}[name=${el.name || el.id}]`),
      );
      expect(unlabeled, "form controls without a label").toEqual([]);
    });
  }

  test("axe scan (violations are recorded, not failed)", async ({ page }, info) => {
    test.setTimeout(180_000);
    const report: Record<string, { id: string; impact: string | null | undefined; help: string; nodes: number; sample: string[] }[]> = {};
    for (const path of PAGES) {
      await goTo(page, path);
      await page.waitForTimeout(800);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      report[path] = r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
        sample: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      }));
    }
    mkdirSync("test-results", { recursive: true });
    writeFileSync(`test-results/axe-${info.project.name}.json`, JSON.stringify(report, null, 2));
    const summary = Object.entries(report)
      .filter(([, v]) => v.length)
      .map(([p, v]) => `${p}: ${v.map((x) => `${x.id}(${x.impact},${x.nodes})`).join(", ")}`);
    console.log(`axe violations (${info.project.name}):\n${summary.join("\n") || "none"}`);
    // Only fail on critical impact so pre-existing serious/moderate issues are reported, not blocking.
    const critical = Object.entries(report).flatMap(([p, v]) => v.filter((x) => x.impact === "critical").map((x) => `${p}: ${x.id}`));
    expect(critical, "critical axe violations").toEqual([]);
  });
});
