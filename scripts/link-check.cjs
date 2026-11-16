/* Crawls primary public pages, collects internal links, and verifies each resolves (no 404/5xx, no login bounce).
 * Usage: QA_BASE_URL=http://127.0.0.1:3102 node scripts/link-check.cjs */
const base = process.env.QA_BASE_URL || "https://www.zapnivo.com";
const seeds = ["/", "/vending/snacks", "/vending/drinks", "/vending/food", "/vending/phone-chargers", "/vending/trading-cards", "/vending/specialty", "/vending/locations", "/vending/request", "/get-a-vending-machine", "/industries", "/industries/offices", "/industries/hotels", "/industries/retail", "/industries/apartments", "/industries/entertainment", "/industries/warehouses", "/industries/restaurants", "/industries/fitness", "/about", "/contact", "/business", "/business/apply", "/how-it-works", "/locations"];
const strip = (h) => h.split("#")[0];
(async () => {
  const links = new Map();
  for (const s of seeds) {
    const res = await fetch(base + s, { redirect: "manual" });
    if (res.status !== 200) { console.log("SEED", s, res.status); continue; }
    const html = await res.text();
    for (const m of html.matchAll(/<a [^>]*href="([^"]+)"/g)) {
      const h = m[1].replace(/&amp;/g, "&");
      if (h.startsWith("/") && !h.startsWith("//") && !h.startsWith("/_next")) (links.get(strip(h)) ?? links.set(strip(h), new Set()).get(strip(h))).add(s);
      if (/^#$|^javascript:/.test(h)) console.log("PLACEHOLDER", h, "on", s);
    }
  }
  const bad = [];
  for (const [l, from] of links) {
    if (!l) continue;
    const r = await fetch(base + l, { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    if (r.status >= 400 || (r.status >= 300 && /login/.test(loc))) bad.push({ link: l, status: r.status, loc, from: [...from].slice(0, 2) });
  }
  console.log(JSON.stringify({ pagesChecked: seeds.length, uniqueLinks: links.size, broken: bad }, null, 2));
})();
