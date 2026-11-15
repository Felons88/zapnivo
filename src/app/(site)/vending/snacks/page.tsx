import type { Metadata } from "next";
import VendingLanding from "@/components/VendingLanding";
import { KioskScenePhoto } from "@/components/Photo";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";
import { resolveVendingCategory, vendingCms, vendingCta, vendingIntro, vendingMetadata } from "@/lib/vending-seo";

const SLUG = "snacks";
const base = VENDING_PAGE_CONTENT[SLUG];

export async function generateMetadata(): Promise<Metadata> {
  return vendingMetadata(base.pageKey, base.metaTitle, base.metaDescription);
}

export default async function VendingSnacksPage() {
  const cms = await vendingCms(base.pageKey);
  const cta = vendingCta(cms, SLUG);
  return (
    <VendingLanding
      category={resolveVendingCategory(SLUG, cms)}
      ctaHref={cta.href}
      ctaLabel={cta.label}
      introBody={vendingIntro(cms)}
      visual={<KioskScenePhoto scene="shopping" />}
    />
  );
}
