import { describe, expect, it } from "vitest";
import { VENDING_CATEGORIES, VENDING_NAV } from "@/lib/vending";

describe("VENDING_CATEGORIES", () => {
  it("defines exactly six categories", () => {
    expect(VENDING_CATEGORIES).toHaveLength(6);
  });

  it("uses unique slugs matching the /vending/<slug> routes", () => {
    const slugs = VENDING_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of VENDING_CATEGORIES) {
      expect(c.href).toBe(`/vending/${c.slug}`);
    }
  });

  it("covers the required placement categories", () => {
    expect(VENDING_CATEGORIES.map((c) => c.slug)).toEqual([
      "snacks",
      "drinks",
      "food",
      "phone-chargers",
      "trading-cards",
      "specialty",
    ]);
  });

  it("has complete copy and CTA fields on every category", () => {
    for (const c of VENDING_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.shortLabel.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.ctaLabel.length).toBeGreaterThan(0);
      expect(c.href.startsWith("/")).toBe(true);
    }
  });

  it("keeps the spec snack description verbatim", () => {
    const snacks = VENDING_CATEGORIES.find((c) => c.slug === "snacks");
    expect(snacks?.description).toBe("Convenient snacks for employees, guests, and customers.");
  });
});

describe("VENDING_NAV", () => {
  it("exposes every category as a menu item", () => {
    expect(VENDING_NAV.items).toHaveLength(VENDING_CATEGORIES.length);
    expect(VENDING_NAV.items.map((i) => i.href)).toEqual(VENDING_CATEGORIES.map((c) => c.href));
  });
});
