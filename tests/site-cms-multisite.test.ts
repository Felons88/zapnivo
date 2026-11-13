import { describe, expect, it } from "vitest";
import {
  FIELD_CATALOG, catalogField, catalogFields, catalogPageExists, catalogPages,
  validateFieldValue, isSiteKey,
} from "@/lib/system/site-cms";

/**
 * Multi-site catalog coverage: every entry must correspond to a real render
 * path (see FIELD_CATALOG docstring in site-cms.ts). These tests pin the
 * contract so a catalog entry can't drift away from what the site renders.
 */
describe("multi-site FIELD_CATALOG", () => {
  it("apex keeps home/global/footer and gains contact (+ newsletter, owned by another workstream)", () => {
    expect(catalogPages("apex")).toEqual(["home", "global", "footer", "newsletter", "contact"]);
    const contact = catalogFields("apex", "contact").map((f) => f.key);
    expect(contact).toEqual(["hero_eyebrow", "hero_title", "hero_description", "meta_title", "meta_description"]);
  });

  it("support home exposes hero + meta fields only", () => {
    expect(catalogPages("support")).toEqual(["home", "global"]);
    const keys = catalogFields("support", "home").map((f) => f.key);
    expect(keys).toEqual(["hero_eyebrow", "hero_headline", "meta_title", "meta_description"]);
    expect(catalogField("support", "home", "hero_headline")?.maxLength).toBe(120);
  });

  it("partners + internal expose only the portal announcement banner", () => {
    for (const site of ["partners", "internal"] as const) {
      expect(catalogPages(site)).toEqual(["global"]);
      expect(catalogFields(site, "global").map((f) => f.key)).toEqual([
        "announcement_enabled", "announcement_text", "announcement_href",
      ]);
      expect(catalogField(site, "global", "announcement_enabled")?.type).toBe("boolean");
    }
  });

  it("customer home exposes hero eyebrow/title + richtext intro", () => {
    expect(catalogPages("customer")).toEqual(["home"]);
    const keys = catalogFields("customer", "home").map((f) => f.key);
    expect(keys).toEqual(["hero_eyebrow", "hero_title", "intro_text"]);
    expect(catalogField("customer", "home", "intro_text")?.type).toBe("richtext");
  });

  it("system and api hosts have no catalog — no render surface", () => {
    expect(catalogPages("system")).toEqual([]);
    expect(catalogPages("api")).toEqual([]);
    expect(catalogField("system", "home", "anything")).toBeNull();
    expect(catalogField("api", "global", "announcement_text")).toBeNull();
  });

  it("every catalog site is a registry site and every page exists", () => {
    for (const site of Object.keys(FIELD_CATALOG)) {
      expect(isSiteKey(site)).toBe(true);
      for (const page of catalogPages(site)) expect(catalogPageExists(site, page)).toBe(true);
    }
  });

  it("no speculative fields leaked in (auth/billing/permission keys)", () => {
    const banned = /password|secret|token|billing|stripe|permission|role|admin_/i;
    for (const [site, pages] of Object.entries(FIELD_CATALOG)) {
      for (const [page, fields] of Object.entries(pages)) {
        for (const f of fields) {
          expect(f.key, `${site}/${page}/${f.key}`).not.toMatch(banned);
        }
      }
    }
  });
});

describe("validation on newly cataloged fields", () => {
  it("announcement_href accepts only https or site-relative", () => {
    const def = catalogField("partners", "global", "announcement_href")!;
    expect(validateFieldValue(def, "https://zapnivo.com/news").ok).toBe(true);
    expect(validateFieldValue(def, "/partners/payouts").ok).toBe(true);
    expect(validateFieldValue(def, "javascript:alert(1)").ok).toBe(false);
    expect(validateFieldValue(def, "http://insecure.example").ok).toBe(false);
  });

  it("hero titles cap at 120 chars and strip markup", () => {
    const def = catalogField("support", "home", "hero_headline")!;
    expect(validateFieldValue(def, "x".repeat(121)).ok).toBe(false);
    const r = validateFieldValue(def, "<b>Need help?</b>");
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.value)).not.toMatch(/[<>]/);
  });

  it("customer intro_text strips HTML and enforces richtext cap", () => {
    const def = catalogField("customer", "home", "intro_text")!;
    const r = validateFieldValue(def, "Welcome back — **check your rentals**.");
    expect(r.ok).toBe(true);
    if (r.ok) expect(String(r.value)).toContain("**check your rentals**");
    expect(validateFieldValue(def, "<script>x</script>").ok).toBe(true); // brackets stripped
    const bad = validateFieldValue(def, "x".repeat(401));
    expect(bad.ok).toBe(false);
  });
});
