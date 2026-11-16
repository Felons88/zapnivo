import type { Metadata } from "next";
import VendingLanding, { type VendingStep } from "@/components/VendingLanding";
import { Notice } from "@/components/ui";
import VendingInquiryForm from "@/components/VendingInquiryForm";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";
import { resolveVendingCategory, vendingCms, vendingCta, vendingIntro, vendingMetadata } from "@/lib/vending-seo";
import { leadSourceTag } from "@/lib/lead-source";

const SLUG = "request";
const base = VENDING_PAGE_CONTENT[SLUG];

export async function generateMetadata(): Promise<Metadata> {
  return vendingMetadata(base.pageKey, base.metaTitle, base.metaDescription);
}

const STEPS: VendingStep[] = [
  { title: "Tell us about your location", body: "Share your space, your customers, and what you're hoping a vending solution could do for them." },
  { title: "We review your space", body: "Our team reviews fit — traffic, footprint, audience — before proposing anything." },
  { title: "Select a solution", body: "We walk through the categories and formats that realistically work for your venue." },
  { title: "Installation & service", body: "Once terms are agreed, Zapnivo coordinates placement and takes care of ongoing service." },
];

export default async function VendingRequestPage({ searchParams }: { searchParams: Promise<{ src?: string | string[] }> }) {
  const { src } = await searchParams;
  const cms = await vendingCms(base.pageKey);
  const cta = vendingCta(cms, SLUG);
  const category = resolveVendingCategory(SLUG, cms);
  return (
    <VendingLanding
      category={category}
      ctaHref={cta.href}
      ctaLabel={cta.label}
      introBody={vendingIntro(cms)}
      steps={STEPS}
    >
      <div className="space-y-6">
        <Notice title="Equipment sales inquiry:">
          Zapnivo is exploring equipment sales through zapnivo.store, which is coming soon. Inquiries about purchasing machines are welcome — share details below and we'll follow up. No prices, stock, or warranty details are published yet.
        </Notice>
        <VendingInquiryForm category="general" source={leadSourceTag(src, "vending_request")} />
      </div>
    </VendingLanding>
  );
}
