import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { PartnerForm } from "@/components/forms";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskPhoto } from "@/components/Photo";

export const metadata: Metadata = {
  title: "Partner Application",
  description: "Apply to host a Zapnivo charging station at your bar, restaurant, hotel or venue. Tell us about your space and we'll schedule a consultation.",
};

export default function Apply() {
  return (
    <>
      <MarketingHero eyebrow="Partner application" title={<>Let's power your venue.</>} description="Tell us about your business, your location, and where a station might fit. This starts a conversation; placement and partnership terms are discussed directly." actions={<Button href="#application">Start application</Button>} visual={<KioskPhoto className="h-80 w-auto object-contain sm:h-96" />} note="Actual Zapnivo kiosk" />
      <Section id="application" className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]">
          <div><Eyebrow className="text-forest">A few details</Eyebrow><h2 className="display-md mt-5">Tell us about your space.</h2><p className="lead mt-5 text-graphite">The application has three short steps. We use the details to understand your venue and prepare for a useful conversation.</p><div className="mt-8 space-y-3">{["Your business and contact", "Your location", "Placement details"].map((item, i) => <div key={item} className="flex items-center gap-4 rounded-lg bg-white p-4"><span className="grid h-9 w-9 place-items-center rounded-full bg-lime font-bold">{i + 1}</span><span className="font-bold">{item}</span></div>)}</div></div>
          <div className="rounded-xl bg-white p-6 md:p-10"><PartnerForm /></div>
        </div>
      </Section>
    </>
  );
}
