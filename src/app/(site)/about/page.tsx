import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskPhoto } from "@/components/Photo";

export const metadata: Metadata = {
  title: { absolute: "About Zapnivo Vending Services | Minnesota Vending & Charging" },
  description: "Zapnivo Vending Services is a Minnesota company bringing convenient self-service vending — snacks, drinks, food, phone chargers, trading cards and specialty items — to venues across the state.",
};

const VALUES = [
  { t: "Honest by default", d: "We only publish locations, partners and numbers that are real. If it isn't live yet, we say so." },
  { t: "Built for movement", d: "Convenience shouldn't anchor you to a wall. Our products exist to keep people moving through their day." },
  { t: "Local first", d: "We started in Central Minnesota and we're building the network venue by venue, not by spreadsheet." },
  { t: "Accessible to everyone", d: "Good service is a basic need. Accessibility in the hardware, the site and the rental flow is a requirement, not a feature." },
];

export default function About() {
  return (
    <>
      <MarketingHero eyebrow="About Zapnivo" title={<>Convenience, served your way.</>} description="Zapnivo Vending Services brings self-service vending to Minnesota venues — starting with portable phone charging and growing into snacks, drinks, food, trading cards and specialty items." actions={<><Button href="/how-it-works">Explore rentals</Button><Button href="/contact" variant="ghost" className="border-white/40 text-white">Get in touch</Button></>} visual={<KioskPhoto className="h-80 w-auto object-contain sm:h-96" />} note="The first Zapnivo kiosk · actual hardware" />

      <Section>
        <div className="grid-12 items-start gap-10">
          <div className="col-span-full lg:col-span-6">
            <Eyebrow className="text-forest">The mission</Eyebrow>
            <h2 className="display-md mt-4">Good service shouldn't require a line.</h2>
            <p className="lead mt-5 text-graphite">Zapnivo was founded to bring convenient self-service vending to the places people already spend time: a restaurant, a hotel lobby, an event, or a campus. It started with portable power — rent a charger bank, keep moving, return it when you're done — and is growing into a broader vending platform.</p>
            <p className="lead mt-4 text-graphite">The first eight-slot charging kiosk has been acquired, and we're now accepting vending placement inquiries across Minnesota. We'll add each venue to the map only when the equipment is live.</p>
          </div>
          <div className="col-span-full space-y-4 lg:col-span-6">
            {VALUES.map((v, i) => (
              <Reveal key={v.t} delay={i * 70} className="rounded-xl border-l-4 border-lime bg-white p-6">
                <h3 className="font-display text-xl font-bold">{v.t}</h3>
                <p className="mt-2 text-graphite">{v.d}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </Section>

      <Section className="bg-mist">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { number: "01", title: "Start with the hardware", text: "The first Zapnivo kiosk is an eight-slot self-service station for portable power-bank rentals — the charging division of a broader vending lineup." },
            { number: "02", title: "Grow the product range", text: "Snacks, beverages, food, phone chargers, trading cards and specialty items are now part of the conversation with Minnesota venues." },
            { number: "03", title: "Show what is live", text: "Every published map pin represents a verified, operating station or machine." },
          ].map(item => <div key={item.number} className="rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest">{item.number}</span><h3 className="mt-9 font-display text-2xl font-bold">{item.title}</h3><p className="mt-3 leading-7 text-graphite">{item.text}</p></div>)}
        </div>
      </Section>
      <Section dark>
        <div className="grid-12 items-center">
          <div className="col-span-full lg:col-span-8">
            <h2 className="display-md">Follow the real rollout.</h2>
            <p className="lead mt-5 text-white/70">Zapnivo is in its early phase. The site will show verified stations, confirmed details, and current rental terms as the network develops. Placement and availability depend on location and equipment.</p>
          </div>
          <div className="col-span-full lg:col-span-4 lg:text-right"><Button href="/contact">Get in touch</Button></div>
        </div>
      </Section>
    </>
  );
}
