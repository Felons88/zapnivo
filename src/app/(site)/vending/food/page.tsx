import type { Metadata } from "next";
import VendingLanding from "@/components/VendingLanding";
import { VendingCategoryVisual } from "@/components/VendingCategoryVisual";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";
import { resolveVendingCategory, vendingCms, vendingCta, vendingIntro, vendingMetadata } from "@/lib/vending-seo";

const SLUG = "food";
const base = VENDING_PAGE_CONTENT[SLUG];

export async function generateMetadata(): Promise<Metadata> {
  return vendingMetadata(base.pageKey, base.metaTitle, base.metaDescription);
}

export default async function VendingFoodPage() {
  const cms = await vendingCms(base.pageKey);
  const cta = vendingCta(cms, SLUG);
  return (
    <VendingLanding
      category={resolveVendingCategory(SLUG, cms)}
      ctaHref={cta.href}
      ctaLabel={cta.label}
      introBody={vendingIntro(cms)}
      visual={<VendingCategoryVisual slug={SLUG} />}
    />
  );
}
