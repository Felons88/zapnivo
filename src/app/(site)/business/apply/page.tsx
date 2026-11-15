import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskPhoto } from "@/components/Photo";
import { GUEST_RENTAL_FACTS, NEXT_STEPS, RESPONSIBILITIES } from "./form";
import { PartnerApplicationForm } from "./PartnerApplicationForm";

export const metadata: Metadata = {
  title: { absolute: "Partner With Zapnivo Vending Services | Host Vending Equipment" },
  description: "Apply to host Zapnivo vending equipment — snacks, beverages, food, phone chargers, trading cards and specialty items — at your Minnesota venue. Self-service for guests, fully managed for you. Now accepting vending placement inquiries.",
};

export default function Apply() {
  return (
    <>
      <MarketingHero eyebrow="Partner application" title={<>Let&apos;s stock your venue.</>} description="Tell us about your business, your location, and which products interest you — snacks, drinks, food, chargers, trading cards and more. Guests serve themselves; Zapnivo handles the equipment and support. This starts a conversation — placement and partnership terms are agreed in writing." actions={<Button href="#application">Start application</Button>} visual={<KioskPhoto className="h-80 w-auto object-contain sm:h-96" />} note="Actual Zapnivo kiosk" />
      <Section id="application" className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]">
          <div>
            <Eyebrow className="text-forest">A few details</Eyebrow>
            <h2 className="display-md mt-5">Tell us about your space.</h2>
            <p className="lead mt-5 text-graphite">Three short steps — about two minutes. Only the first two are required; placement details help us prepare for a useful conversation.</p>
            <div className="mt-8 space-y-3">{["Your business and contact", "Your location", "Placement details (optional)"].map((item, i) => <div key={item} className="flex items-center gap-4 rounded-lg bg-white p-4"><span className="grid h-9 w-9 place-items-center rounded-full bg-lime font-bold">{i + 1}</span><span className="font-bold">{item}</span></div>)}</div>

            <div className="mt-10">
              <Eyebrow className="text-forest">What guests pay for charger rentals</Eyebrow>
              <ul className="mt-4 flex flex-wrap gap-2">{GUEST_RENTAL_FACTS.map((fact) => <li key={fact} className="rounded-full bg-white px-4 py-2 text-sm font-bold text-ink">{fact}</li>)}</ul>
              <p className="mt-3 text-sm leading-6 text-graphite">For our charging division, guests handle their own rental and payment. Vending pricing is set per machine and confirmed in your partnership terms. You don&apos;t staff it, stock it, or chase returns.</p>
            </div>

            <div className="mt-10">
              <Eyebrow className="text-forest">Who does what</Eyebrow>
              <div className="mt-4 space-y-3">{RESPONSIBILITIES.map((r) => <div key={r.who} className="rounded-lg bg-white p-4"><p className="font-bold text-ink">{r.who}</p><p className="mt-1 text-sm leading-6 text-graphite">{r.items}</p></div>)}</div>
            </div>

            <div className="mt-10 rounded-lg bg-white p-5">
              <p className="text-sm font-bold text-ink">Revenue share is available.</p>
              <p className="mt-1 text-sm leading-6 text-graphite">Partnership structures vary by venue. Any revenue share — and all other terms — is agreed privately and documented in your partnership agreement before installation. We don&apos;t publish unfinalized terms.</p>
            </div>

            <div className="mt-10">
              <Eyebrow className="text-forest">What happens next</Eyebrow>
              <ol className="mt-4 space-y-3">{NEXT_STEPS.map((item, i) => <li key={item.title} className="flex gap-3 text-sm"><span className="font-display text-lg font-bold text-forest/40">{String(i + 1).padStart(2, "0")}</span><div><span className="font-bold text-ink">{item.title}.</span> <span className="text-graphite">{item.body}</span></div></li>)}</ol>
            </div>
          </div>
          <div className="rounded-xl bg-white p-6 md:p-10"><PartnerApplicationForm /></div>
        </div>
      </Section>
    </>
  );
}
