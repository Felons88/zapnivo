const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const base = process.env.QA_BASE_URL || "http://127.0.0.1:3102";
  const results = [];
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    for (const route of ["/", "/vending/snacks", "/industries/offices", "/about", "/get-a-vending-machine"]) {
      await page.goto(base + route, { waitUntil: "networkidle" });
      const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      results.push({ name, route, violations: report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
    }
    if (name === "mobile") {
      await page.goto(base, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Open menu" }).click();
      const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      results.push({ name, route: "mobile menu", violations: report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) });
    }
    await context.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.violations.length)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
