import { describe, expect, it } from "vitest";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";

const SLUGS = [
  "snacks",
  "drinks",
  "food",
  "phone-chargers",
  "trading-cards",
  "specialty",
  "locations",
  "request",
];

const REQUIRED_STRING_FIELDS = [
  "slug",
  "pageKey",
  "label",
  "tagline",
  "eyebrow",
  "title",
  "overview",
  "metaTitle",
  "metaDescription",
  "ctaHref",
  "ctaLabel",
] as const;

describe("VENDING_PAGE_CONTENT", () => {
  it("contains all 8 vending landing page slugs", () => {
    for (const slug of SLUGS) {
      expect(VENDING_PAGE_CONTENT[slug], `missing slug: ${slug}`).toBeDefined();
    }
    expect(Object.keys(VENDING_PAGE_CONTENT)).toHaveLength(SLUGS.length);
  });

  it("has non-empty required fields on every entry", () => {
    for (const slug of SLUGS) {
      const entry = VENDING_PAGE_CONTENT[slug];
      for (const field of REQUIRED_STRING_FIELDS) {
        expect(typeof entry[field], `${slug}.${field}`).toBe("string");
        expect((entry[field] as string).trim().length, `${slug}.${field} empty`).toBeGreaterThan(0);
      }
      expect(entry.slug).toBe(slug);
      expect(entry.suitableLocations.length).toBeGreaterThan(0);
      expect(entry.ownerBenefits.length).toBeGreaterThan(0);
      expect(entry.faqs.length).toBeGreaterThan(0);
      for (const loc of entry.suitableLocations) expect(loc.trim().length).toBeGreaterThan(0);
      for (const b of entry.ownerBenefits) expect(b.trim().length).toBeGreaterThan(0);
      for (const f of entry.faqs) {
        expect(f.q.trim().length).toBeGreaterThan(0);
        expect(f.a.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("maps each slug to its expected CMS page_key", () => {
    const expected: Record<string, string> = {
      snacks: "vending_snacks",
      drinks: "vending_drinks",
      food: "vending_food",
      "phone-chargers": "vending_chargers",
      "trading-cards": "vending_cards",
      specialty: "vending_specialty",
      locations: "vending_locations",
      request: "placement",
    };
    for (const slug of SLUGS) {
      expect(VENDING_PAGE_CONTENT[slug].pageKey).toBe(expected[slug]);
    }
  });

  it("makes no forbidden claims (licenses, fake fleet, guaranteed freebies)", () => {
    // Scoped regexes — "Installation & service" (a process step title) is fine,
    // but claims like "official Pokémon partner", "licensed by Nintendo",
    // or an "already installed fleet" are not.
    const forbidden = [
      /official pok[eé]mon/i,
      /licensed by/i,
      /officially licen[cs]ed/i,
      /partnered with pok[eé]mon/i,
      /already installed/i,
      /installed fleet/i,
      /free installation/i,
      /guaranteed (income|revenue|profit)/i,
    ];
    const corpus = SLUGS.map((slug) => {
      const e = VENDING_PAGE_CONTENT[slug];
      return JSON.stringify({
        ...e,
        suitableLocations: e.suitableLocations,
        ownerBenefits: e.ownerBenefits,
        faqs: e.faqs,
        relatedLinks: e.relatedLinks,
      });
    }).join("\n");
    for (const pattern of forbidden) {
      expect(corpus).not.toMatch(pattern);
    }
  });

  it("trading-cards copy stays descriptive and non-trademarked", () => {
    const cards = VENDING_PAGE_CONTENT["trading-cards"];
    expect(cards.title).toBe("Trading Card & Collectible Vending");
    expect(cards.overview).toContain("subject to product availability and sourcing");
    const corpus = JSON.stringify(cards);
    // Affirmative licensee/partner claims are forbidden (the FAQ disclaimer
    // that denies them is fine — scoped patterns only).
    expect(corpus).not.toMatch(/licensed by|officially licen[cs]ed|partnered with|official partner/i);
    expect(corpus).not.toMatch(/nintendo/i);
    // No Nintendo/Pokémon logo or branded-art references.
    expect(corpus).not.toMatch(/logo|trademark|brand art/i);
    // Pokémon appears only descriptively.
    if (/pok[eé]mon/i.test(corpus)) {
      expect(corpus).toMatch(/not an official|where sourced|subject to/i);
    }
  });

  it("phone-chargers describes the rental service, not equipment sales", () => {
    const chargers = VENDING_PAGE_CONTENT["phone-chargers"];
    expect(chargers.overview).toContain("portable charging");
    const corpus = JSON.stringify(chargers);
    expect(corpus).not.toMatch(/buy (a|the) (machine|kiosk)/i);
    expect(chargers.relatedLinks.some((l) => l.href === "/how-it-works")).toBe(true);
  });
});
