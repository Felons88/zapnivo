import type { Metadata } from "next";
import VendingLanding, { type VendingStep } from "@/components/VendingLanding";
import VendingInquiryForm from "@/components/VendingInquiryForm";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";
import { resolveVendingCategory, vendingCms, vendingCta, vendingIntro, vendingMetadata } from "@/lib/vending-seo";

const SLUG = "request";
const base = VENDING_PAGE_CONTENT[SLUG];

const META_FALLBACK = {
  title: "Get a Vending Machine for Your Business | Zapnivo",
  description: "Want a vending machine at your business? Zapnivo works with Minnesota businesses and property managers to explore tailored vending placements.",
};

export async function generateMetadata(): Promise<Metadata> {
  // Same CMS page_key ("placement") as /vending/request, with this page's own fallbacks.
  return vendingMetadata(base.pageKey, META_FALLBACK.title, META_FALLBACK.description, "/get-a-vending-machine");
}

const STEPS: VendingStep[] = [
  { title: "Tell us about your location", body: "Share your space, your customers, and what you're hoping a vending solution could do for them." },
  { title: "We review your space", body: "Our team reviews fit — traffic, footprint, audience — before proposing anything." },
  { title: "Select a solution", body: "We walk through the categories and formats that realistically work for your venue." },
  { title: "Installation & service", body: "Once terms are agreed, Zapnivo coordinates placement and takes care of ongoing service." },
];

export default async function GetAVendingMachinePage() {
  const cms = await vendingCms(base.pageKey);
  const cta = vendingCta(cms, SLUG);
  const category = {
    ...resolveVendingCategory(SLUG, cms),
    label: "Get a Vending Machine",
    eyebrow: "Vending machine placement",
    title: "Want a Vending Machine at Your Business?",
  };
  return (
    <VendingLanding
      category={category}
      ctaHref={cta.href}
      ctaLabel={cta.label}
      introBody={vendingIntro(cms)}
      steps={STEPS}
    >
      <VendingInquiryForm category="general" source="placement_page" />
    </VendingLanding>
  );
}
