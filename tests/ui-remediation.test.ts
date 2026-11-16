import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeFaq } from "@/components/HomeFaq";
import VendingLanding from "@/components/VendingLanding";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";

describe("homepage FAQ is business-focused", () => {
  const html = renderToStaticMarkup(h(HomeFaq));
  it("asks about vending placement, not charger rentals", () => {
    expect(html).toContain("How can my business request a vending machine?");
    expect(html).toContain("What happens after I submit an inquiry?");
    expect(html).not.toMatch(/rent a power bank|Where can I return it|How much does a rental cost/i);
  });
  it("makes no free-placement or income guarantees", () => {
    expect(html).not.toMatch(/free placement|guaranteed|revenue guarantee/i);
  });
  it("FAQPage JSON-LD questions match the visible questions", () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1].replace(/&quot;/g, '"'));
    const names: string[] = ld.mainEntity.map((q: { name: string }) => q.name.replace(/'/g, "&#x27;"));
    for (const n of names) expect(html).toContain(n);
    expect(names).toHaveLength(8);
  });
});

describe("vending landing closing headings", () => {
  for (const slug of Object.keys(VENDING_PAGE_CONTENT)) {
    it(`${slug}: heading is written copy, not built from the label`, () => {
      const html = renderToStaticMarkup(h(VendingLanding, { category: VENDING_PAGE_CONTENT[slug], ctaHref: "/vending/request", ctaLabel: "Go" }));
      expect(html).not.toMatch(/Interested in (get|request)/i);
      expect(html).not.toMatch(/Interested in [a-z ]*\bservices?\b\?/i);
    });
  }
  it("request page puts the form before the explanatory sections", () => {
    const html = renderToStaticMarkup(h(VendingLanding, { category: VENDING_PAGE_CONTENT.request, ctaHref: "/x", ctaLabel: "Go" }, h("form", { id: "probe" })));
    expect(html).toContain("Ready to bring vending to your business?");
    expect(html.indexOf('id="probe"')).toBeLessThan(html.indexOf("Suitable locations."));
    expect(html.match(/id="probe"/g)).toHaveLength(1);
  });
});

describe("category imagery", () => {
  it("snacks and drinks use distinct image files", async () => {
    const src = (await import("node:fs")).readFileSync("src/components/VendingCategoryVisual.tsx", "utf8");
    const snacks = /snacks: \{ src: "([^"]+)"/.exec(src)![1];
    const drinks = /drinks: \{ src: "([^"]+)"/.exec(src)![1];
    expect(snacks).not.toBe(drinks);
  });
});

describe("industry hero imagery", () => {
  it("every industry has an existing hero image and honest caption logic", async () => {
    const fs = await import("node:fs");
    const { INDUSTRIES } = await import("@/app/(site)/industries/data");
    const src = fs.readFileSync("src/app/(site)/industries/[slug]/page.tsx", "utf8");
    for (const { slug } of INDUSTRIES) {
      const m = new RegExp(`${slug}: \{ src: "(/images/[^"]+)"`).exec(src);
      expect(m, slug).not.toBeNull();
      expect(fs.existsSync(`public${m![1]}`), m![1]).toBe(true);
    }
    expect(src).toContain("not an installed machine");
  });
});

describe("tracking parameters", () => {
  it("lead source tag cannot carry markup from fbclid/utm-style input", async () => {
    const { leadSourceTag } = await import("@/lib/lead-source");
    expect(leadSourceTag("<img src=x onerror=alert(1)>", "fb")).toMatch(/^[a-z0-9_-]+$/);
  });
});
