/* UI audit: viewport matrix + geometry checks + interaction screenshots.
 * Usage: QA_BASE_URL=https://www.zapnivo.com QA_OUT=artifacts/ui-audit/before node scripts/ui-audit.cjs */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const FB = "?fbclid=IwY2xjawVm8JZleHRuA2FlbQIxMABwZG9mAWJyaWQRMVVMYVNlUVU2NHNXWndzeUFzcnRjBmFwcF9pZBAyMjIwMzkxNzg4MjAwODkyAAEf0fh4EPRkL1ZYz6Oq6_M2bTi5wX4LO8sCi6FXcQq07NhJyVrV9HMs7cjU0wQ_aem_BZoN5LfJdL9w_NOA3bJt_g";
const VIEWPORTS = [[375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1366, 768], [1440, 900], [1920, 1080]];
const ROUTES = [["/" + FB, "home-fbclid"], ["/", "home"], ["/vending/snacks", "snacks"], ["/vending/drinks", "drinks"], ["/industries/offices", "industry-offices"], ["/get-a-vending-machine", "inquiry"], ["/contact", "contact"], ["/business", "business"], ["/business/apply", "apply"], ["/about", "about"]];

async function settle(page) {
  const decline = page.getByRole("button", { name: "Decline" });
  if (await decline.isVisible().catch(() => false)) await decline.click();
  await page.evaluate(async () => {
    const step = Math.max(400, window.innerHeight * .8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo({ top: y, behavior: "instant" }); await new Promise(r => setTimeout(r, 30)); }
    for (const i of document.images) { i.scrollIntoView({ block: "center" }); await i.decode().catch(() => {}); }
    window.scrollTo({ top: 0, behavior: "instant" }); await new Promise(r => setTimeout(r, 120));
  });
}

const geometry = () => {
  const vw = window.innerWidth, out = [];
  const overflow = document.documentElement.scrollWidth > vw + 2;
  for (const el of document.querySelectorAll("main *, header *, footer *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.visibility === "hidden") continue;
    if (r.right > vw + 2 && !el.closest("[aria-hidden='true'], .sr-only, .mobile-menu")) out.push({ kind: "outside-viewport", tag: el.tagName, cls: String(el.className).slice(0, 60), right: Math.round(r.right) });
    if (["H1", "H2", "H3", "P", "A", "BUTTON"].includes(el.tagName) && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== "visible" && cs.overflowX !== "auto") out.push({ kind: "text-clipped", tag: el.tagName, text: (el.textContent || "").slice(0, 40) });
  }
  const tiny = [...document.querySelectorAll("a,button")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 24 && !e.closest(".sr-only") && getComputedStyle(e).display !== "inline"; }).slice(0, 5).map(e => (e.textContent || "").trim().slice(0, 30));
  const broken = [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute("src"));
  const h1 = document.querySelectorAll("h1").length;
  return { overflow, issues: out.slice(0, 8), smallTargets: tiny, broken, h1, docHeight: document.documentElement.scrollHeight };
};

async function main() {
  const base = process.env.QA_BASE_URL || "https://www.zapnivo.com";
  const out = path.resolve(process.env.QA_OUT || "artifacts/ui-audit/after");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const findings = [];
  const save = async (page, name, opts = {}) => {
    const png = await page.screenshot({ animations: "disabled", ...opts });
    await sharp(png).webp({ quality: 66 }).toFile(path.join(out, `${name}.webp`));
  };
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    for (const [route, slug] of ROUTES) {
      if (!["home", "home-fbclid"].includes(slug) && ![375, 768, 1440].includes(w)) continue;
      const res = await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.locator("main").waitFor({ timeout: 15000 });
      await settle(page);
      const g = await page.evaluate(geometry);
      findings.push({ page: route.split("?")[0] + (route.includes("?") ? "?fbclid" : ""), viewport: `${w}x${h}`, status: res?.status(), ...g });
      if (slug !== "home-fbclid" || w === 390) await save(page, `${w}-${slug}`, { fullPage: true });
    }
    // interactions
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await settle(page);
    if (w >= 1280) {
      for (const label of ["Vending Solutions", "Industries", "For Businesses", "About Us"]) {
        const b = page.getByRole("button", { name: label, exact: true });
        if (await b.count()) { await b.hover(); await b.click(); await page.waitForTimeout(200);
          if (w === 1440 || w === 1366) await save(page, `${w}-menu-${label.replace(/\s+/g, "-").toLowerCase()}`);
          const box = await page.locator("#desktop-mega-menu").boundingBox().catch(() => null);
          if (box && (box.x < -1 || box.x + box.width > w + 1)) findings.push({ page: "/", viewport: `${w}x${h}`, menu: label, issue: "mega-menu outside viewport" });
          await page.keyboard.press("Escape"); }
      }
    } else {
      const open = page.getByRole("button", { name: "Open menu" });
      if (await open.isVisible().catch(() => false)) {
        await open.click(); await page.waitForTimeout(500);
        await save(page, `${w}-mobile-menu`);
        const m = await page.evaluate(() => { const el = document.querySelector("#mobile-menu"); return { scrollable: el.scrollHeight > el.clientHeight, bodyLocked: getComputedStyle(document.body).overflow }; });
        findings.push({ page: "/", viewport: `${w}x${h}`, mobileMenu: m });
      }
    }
    await ctx.close();
  }
  // form error state (no submission to server — client validation only)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(base + "/get-a-vending-machine", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.locator("form button[type=submit]").first().scrollIntoViewIfNeeded();
  await page.locator("form button[type=submit]").first().click();
  await page.waitForTimeout(400);
  await save(page, "390-inquiry-validation");
  await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(out, "findings.json"), JSON.stringify(findings, null, 2));
  const bad = findings.filter(f => f.overflow || f.issue || (f.issues && f.issues.length) || (f.broken && f.broken.length) || (f.status && f.status !== 200) || f.h1 === 0 || f.h1 > 1);
  console.log(JSON.stringify({ checks: findings.length, flagged: bad.length, out }, null, 2));
  for (const b of bad.slice(0, 40)) console.log(JSON.stringify(b).slice(0, 300));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
