import { describe, expect, it } from "vitest";
import {
  catalogField, catalogFields, catalogPageExists, catalogPages,
  validateFieldValue,
} from "@/lib/system/site-cms";

/**
 * Zapnivo rebrand catalog additions: vending category pages, the placement
 * page, new homepage hero/solutions/bottom-CTA fields, and footer contact
 * fields. Page consumers (wired by another workstream) rely on these exact
 * keys — this test pins the contract.
 */

const VENDING_PAGES = [
  "vending_snacks", "vending_drinks", "vending_food", "vending_chargers",
  "vending_cards", "vending_specialty", "vending_locations", "placement",
] as const;

const VENDING_FIELDS = [
  "hero_eyebrow", "hero_title", "hero_description", "intro_body",
  "meta_title", "meta_description", "cta_label", "cta_href",
];

describe("vending + placement page catalog", () => {
  it("all 8 page_keys exist under apex", () => {
    for (const page of VENDING_PAGES) {
      expect(catalogPageExists("apex", page)).toBe(true);
      expect(catalogFields("apex", page)).toHaveLength(VENDING_FIELDS.length);
    }
    expect(catalogPages("apex").slice(-8)).toEqual([...VENDING_PAGES]);
  });

  it("each page has the uniform field set", () => {
    for (const page of VENDING_PAGES) {
      expect(catalogFields("apex", page).map((f) => f.key)).toEqual(VENDING_FIELDS);
    }
  });

  it("field types + length caps match spec", () => {
    expect(catalogField("apex", "placement", "hero_eyebrow")?.type).toBe("string");
    expect(catalogField("apex", "placement", "hero_eyebrow")?.maxLength).toBe(120);
    expect(catalogField("apex", "placement", "hero_title")?.maxLength).toBe(120);
    expect(catalogField("apex", "placement", "hero_description")?.type).toBe("richtext");
    expect(catalogField("apex", "placement", "hero_description")?.maxLength).toBe(600);
    expect(catalogField("apex", "placement", "intro_body")?.type).toBe("richtext");
    expect(catalogField("apex", "placement", "intro_body")?.maxLength).toBe(1200);
    expect(catalogField("apex", "placement", "meta_title")?.maxLength).toBe(70);
    expect(catalogField("apex", "placement", "meta_description")?.maxLength).toBe(170);
    expect(catalogField("apex", "placement", "cta_label")?.maxLength).toBe(60);
    expect(catalogField("apex", "placement", "cta_href")?.type).toBe("url");
  });

  it("unknown vending fields still resolve to null", () => {
    expect(catalogField("apex", "placement", "hero_cta1_label")).toBeNull();
    expect(catalogField("support", "placement", "hero_title")).toBeNull();
  });
});

describe("apex home rebrand fields", () => {
  const homeKeys = [
    "hero_cta1_label", "hero_cta1_href",
    "hero_cta2_label", "hero_cta2_href",
    "hero_cta3_label", "hero_cta3_href",
    "solutions_eyebrow", "solutions_title", "solutions_intro",
    "bottom_cta_title", "bottom_cta_body",
  ];

  it("all new home keys exist and resolve via catalogField", () => {
    const keys = catalogFields("apex", "home").map((f) => f.key);
    for (const k of homeKeys) {
      expect(keys).toContain(k);
      expect(catalogField("apex", "home", k)).not.toBeNull();
    }
    // original hero/meta fields preserved
    for (const k of ["hero_eyebrow", "hero_headline_a", "hero_headline_b", "hero_subhead", "meta_title", "meta_description"]) {
      expect(keys).toContain(k);
    }
  });

  it("home field types + caps match spec", () => {
    for (const k of ["hero_cta1_label", "hero_cta2_label", "hero_cta3_label"]) {
      expect(catalogField("apex", "home", k)?.type).toBe("string");
      expect(catalogField("apex", "home", k)?.maxLength).toBe(60);
    }
    for (const k of ["hero_cta1_href", "hero_cta2_href", "hero_cta3_href"]) {
      expect(catalogField("apex", "home", k)?.type).toBe("url");
    }
    expect(catalogField("apex", "home", "solutions_eyebrow")?.maxLength).toBe(120);
    expect(catalogField("apex", "home", "solutions_title")?.maxLength).toBe(120);
    expect(catalogField("apex", "home", "solutions_intro")?.type).toBe("richtext");
    expect(catalogField("apex", "home", "solutions_intro")?.maxLength).toBe(600);
    expect(catalogField("apex", "home", "bottom_cta_title")?.maxLength).toBe(120);
    expect(catalogField("apex", "home", "bottom_cta_body")?.type).toBe("richtext");
    expect(catalogField("apex", "home", "bottom_cta_body")?.maxLength).toBe(400);
  });
});

describe("apex footer contact fields", () => {
  it("contact_phone + mailing_address exist alongside contact_email", () => {
    const keys = catalogFields("apex", "footer").map((f) => f.key);
    expect(keys).toEqual(["contact_email", "contact_phone", "mailing_address"]);
    expect(catalogField("apex", "footer", "contact_phone")?.type).toBe("string");
    expect(catalogField("apex", "footer", "contact_phone")?.maxLength).toBe(40);
    expect(catalogField("apex", "footer", "mailing_address")?.type).toBe("richtext");
    expect(catalogField("apex", "footer", "mailing_address")?.maxLength).toBe(200);
  });
});

describe("validation on new fields", () => {
  it("cta_href rejects javascript: and unsafe URLs", () => {
    const cta = catalogField("apex", "placement", "cta_href")!;
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.com", "http://insecure.com"]) {
      expect(validateFieldValue(cta, bad).ok).toBe(false);
    }
    expect(validateFieldValue(cta, "https://zapnivo.com/get-a-vending-machine").ok).toBe(true);
    expect(validateFieldValue(cta, "/vending/snacks").ok).toBe(true);
    expect(validateFieldValue(cta, "").ok).toBe(true); // empty = unset
  });

  it("meta_description over 170 chars is rejected", () => {
    const meta = catalogField("apex", "vending_drinks", "meta_description")!;
    expect(validateFieldValue(meta, "x".repeat(170)).ok).toBe(true);
    expect(validateFieldValue(meta, "x".repeat(171)).ok).toBe(false);
  });

  it("richtext fields strip markup and enforce caps", () => {
    const intro = catalogField("apex", "vending_snacks", "intro_body")!;
    const r = validateFieldValue(intro, "<b>bold</b> text");
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.value)).not.toMatch(/[<>]/);
    expect(validateFieldValue(intro, "x".repeat(1201)).ok).toBe(false);
  });
});
