import type { Metadata } from "next";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { VENDING_PAGE_CONTENT, type VendingPageContent } from "@/lib/vending-content";

/**
 * SEO + CMS helpers for the Zapnivo Vending Services landing pages.
 *
 * CMS keys live under site "apex" with page_keys:
 *   vending_snacks, vending_drinks, vending_food, vending_chargers,
 *   vending_cards, vending_specialty, vending_locations, placement.
 *
 * Editable fields per page: hero_eyebrow, hero_title, hero_description,
 * intro_body (richtext — **bold** only), meta_title, meta_description,
 * cta_label, cta_href. Missing CMS rows resolve to the hardcoded fallbacks
 * in src/lib/vending-content.ts.
 */

export type VendingCms = Awaited<ReturnType<typeof getPublishedContent>>;

/** Fetch the published CMS field map for a vending page. Never throws. */
export async function vendingCms(pageKey: string): Promise<VendingCms> {
  return getPublishedContent("apex", pageKey);
}

/** Metadata override helper — absolute title, CMS-overridable description. */
export async function vendingMetadata(
  pageKey: string,
  fallbackTitle: string,
  fallbackDescription: string,
): Promise<Metadata> {
  const cms = await vendingCms(pageKey);
  return {
    title: { absolute: cmsText(cms, "meta_title", fallbackTitle) },
    description: cmsText(cms, "meta_description", fallbackDescription),
  };
}

export { cmsText };

/** Merge CMS hero overrides into the hardcoded category content. */
export function resolveVendingCategory(slug: string, cms: VendingCms): VendingPageContent {
  const base = VENDING_PAGE_CONTENT[slug];
  return {
    ...base,
    eyebrow: cmsText(cms, "hero_eyebrow", base.eyebrow),
    title: cmsText(cms, "hero_title", base.title),
    overview: cmsText(cms, "hero_description", base.overview),
  };
}

/** CMS-overridable CTA pair. */
export function vendingCta(cms: VendingCms, slug: string): { href: string; label: string } {
  const base = VENDING_PAGE_CONTENT[slug];
  return {
    href: cmsText(cms, "cta_href", base.ctaHref),
    label: cmsText(cms, "cta_label", base.ctaLabel),
  };
}

/** CMS richtext intro paragraph ("" when unset). */
export function vendingIntro(cms: VendingCms): string {
  return cmsText(cms, "intro_body", "");
}
