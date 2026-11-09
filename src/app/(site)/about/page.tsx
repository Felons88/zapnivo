import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskPhoto } from "@/components/Photo";

export const metadata: Metadata = {
  title: "About Zapnivo | Portable Charging Network",
  description: "Zapnivo is a Minnesota-based startup building a portable phone-charger rental network serving Minnesota.",
};

const VALUES = [
  { t: "Honest by default", d: "We only publish locations, partners and numbers that are real. If it isn't live yet, we say so." },
  { t: "Built for movement", d: "Charging shouldn't anchor you to a wall. The product exists to keep people moving through their day." },
  { t: "Local first", d: "We started in Central Minnesota and we're building the network venue by venue, not by spreadsheet." },
  { t: "Accessible to everyone", d: "Charging is a basic need. Accessibility in the hardware, the site and the rental flow is a requirement, not a feature." },
];

export default function About() {
  return (
    <>
      <MarketingHero eyebrow="About Zapnivo" title={<>Power should move with you.</>} description="We're building a self-service portable charging network from Minnesota, one verified station at a time." actions={<><Button href="/how-it-works">Explore rentals</Button><Button href="/contact" variant="ghost" className="border-white/40 text-white">Get in touch</Button></>} visual={<KioskPhoto className="h-80 w-auto object-contain sm:h-96" />} note="The first Zapnivo kiosk · actual hardware" />

      <Section>
        <div className="grid-12 items-start gap-10">
          <div className="col-span-full lg:col-span-6">
            <Eyebrow className="text-forest">The mission</Eyebrow>
            <h2 className="display-md mt-4">A low battery shouldn't end the plan.</h2>
            <p className="lead mt-5 text-graphite">Zapnivo exists to make portable power available where people already spend time: a restaurant, a hotel lobby, an event, or a campus. Rent at a station, keep moving, and return the bank when you're done.</p>
            <p className="lead mt-4 text-graphite">The first eight-slot kiosk has been acquired. We're preparing installations in Minnesota and will add each venue to the map only when the station is live.</p>
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
            { number: "01", title: "Start with the hardware", text: "The first Zapnivo kiosk is an eight-slot self-service station for portable power-bank rentals." },
            { number: "02", title: "Build the venue network", text: "We work with Minnesota venues on placement, installation, and ongoing support." },
            { number: "03", title: "Show what is live", text: "Every published map pin represents a verified, operating station." },
          ].map(item => <div key={item.number} className="rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest/25">{item.number}</span><h3 className="mt-9 font-display text-2xl font-bold">{item.title}</h3><p className="mt-3 leading-7 text-graphite">{item.text}</p></div>)}
        </div>
      </Section>
      <Section dark>
        <div className="grid-12 items-center">
          <div className="col-span-full lg:col-span-8">
            <h2 className="display-md">Follow the real rollout.</h2>
            <p className="lead mt-5 text-white/70">Zapnivo is in its early phase. The site will show verified stations, confirmed details, and current rental terms as the network develops.</p>
          </div>
          <div className="col-span-full lg:col-span-4 lg:text-right"><Button href="/contact">Get in touch</Button></div>
        </div>
      </Section>
    </>
  );
}
