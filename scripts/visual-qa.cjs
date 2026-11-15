const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

async function main() {
  const base = process.env.QA_BASE_URL || "http://127.0.0.1:3102";
  const output = path.resolve("artifacts/brand-qa/after");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const routes = [
    ["/", "home"], ["/industries", "industries"],
    ...["offices", "hotels", "apartments", "retail", "entertainment", "warehouses", "restaurants", "fitness"].map(slug => [`/industries/${slug}`, `industry-${slug}`]),
    ...["snacks", "drinks", "food", "phone-chargers", "trading-cards", "specialty"].map(slug => [`/vending/${slug}`, `service-${slug}`]),
    ["/about", "about"], ["/get-a-vending-machine", "inquiry"], ["/locations", "charging-locations"],
  ];
  const findings = [];
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    for (const [route, slug] of routes) {
      const response = await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator("main").waitFor({ timeout: 15000 });
      const decline = page.getByRole("button", { name: "Decline" });
      if (await decline.isVisible().catch(() => false)) await decline.click();
      await page.evaluate(async () => {
        const step = Math.max(400, window.innerHeight * .8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo({ top: y, behavior: "instant" });
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        for (const image of document.images) {
          image.scrollIntoView({ block: "center" });
          await new Promise(resolve => setTimeout(resolve, 80));
          await image.decode().catch(() => {});
        }
        window.scrollTo({ top: 0, behavior: "instant" });
        await new Promise(resolve => setTimeout(resolve, 150));
      });
      await page.screenshot({ path: path.join(output, `${name}-${slug}.png`), fullPage: true, animations: "disabled" });
      const details = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        brokenImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute("src")),
        title: document.title,
      }));
      findings.push({ name, route, status: response?.status(), ...details });
    }
    await page.goto(base, { waitUntil: "domcontentloaded" });
    if (name === "desktop") {
      await page.getByRole("button", { name: "Vending Solutions" }).click();
      await page.screenshot({ path: path.join(output, "desktop-mega-menu.png"), animations: "disabled" });
    } else {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.screenshot({ path: path.join(output, "mobile-menu.png"), animations: "disabled" });
    }
    await context.close();
  }
  await browser.close();
  for (const file of fs.readdirSync(output).filter(file => file.endsWith(".png"))) {
    const source = path.join(output, file);
    await sharp(source).webp({ quality: 68 }).toFile(path.join(output, file.replace(/\.png$/, ".webp")));
    fs.unlinkSync(source);
  }
  fs.writeFileSync(path.join(output, "findings.json"), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify({ screenshots: findings.length + 2, issues: findings.filter(x => x.status !== 200 || x.overflow || x.brokenImages.length), output }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
