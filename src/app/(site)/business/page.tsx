import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskScenePhoto } from "@/components/Photo";
import { Reveal } from "@/components/Reveal";

export const metadata: Metadata = { title: { absolute: "Phone Charging Stations for Businesses | Zapnivo" }, description: "Explore a managed Zapnivo charging station for your venue. Learn about guest rentals, placement, servicing, and the partnership process." };
const FIT = [
  { title: "Hospitality", places: "Hotels · Restaurants · Cafés", body: "Help guests stay connected while they settle in, dine, or wait." },
  { title: "Entertainment", places: "Bars · Nightlife · Event venues", body: "Let guests carry the charge through the night without asking staff for an outlet." },
  { title: "Everyday destinations", places: "Campuses · Shopping centers", body: "Give people a portable charging option where they already spend time." },
];
const PROCESS = [
  { n: "01", title: "Tell us about your space", body: "Share your venue type, location, and contact details in the partner application." },
  { n: "02", title: "Plan the placement", body: "We discuss where a station could be visible and practical without interrupting your operation." },
  { n: "03", title: "Agree on the details", body: "Installation and partnership terms are reviewed privately and documented before moving forward." },
  { n: "04", title: "Set up and support", body: "Zapnivo installs the station and manages equipment, software, and rental support." },
];
const FAQ = [
  { q: "Does my team have to manage rentals?", a: "No. Rentals are designed to be self-service, with rental support handled by Zapnivo." },
  { q: "Where does the station go?", a: "We plan placement with each venue. The first kiosk has a compact counter footprint, and installation details are confirmed before setup." },
  { q: "What are the financial terms?", a: "Partnership structures are discussed privately during consultation and documented in an agreement. We do not publish unfinalized terms." },
];

export default function Business() {
  return <>
    <MarketingHero eyebrow="For businesses" title={<>Give your guests power to go.</>} description="A managed charging amenity for the places people gather. Guests rent a portable power bank; Zapnivo handles the station, servicing, software, and customer support." actions={<><Button href="/business/apply">Partner With Zapnivo</Button><Button href="/contact?topic=partnerships" variant="ghost" className="border-white/40 text-white">Request a Consultation</Button></>} visual={<KioskScenePhoto scene="hotel" />} note="Illustrative kiosk placement · hotel lobby" />
    <Section id="venue-fit"><div className="grid gap-6 lg:grid-cols-[.8fr_1.2fr] lg:items-end"><div><Eyebrow className="text-forest">Where it fits</Eyebrow><h2 className="display-lg mt-5">A useful amenity in busy places.</h2></div><p className="lead max-w-2xl text-graphite">The best placement is easy for guests to notice and simple for your staff to work around. We review the space together before any installation.</p></div><div className="mt-11 grid gap-4 md:grid-cols-3">{FIT.map((item, i) => <Reveal key={item.title} delay={i * 70} className="flex min-h-72 flex-col rounded-xl bg-white p-7"><span className="eyebrow text-forest">{item.places}</span><h3 className="mt-auto font-display text-3xl font-bold">{item.title}</h3><p className="mt-3 text-graphite">{item.body}</p></Reveal>)}</div></Section>
    <Section dark><div className="grid items-center gap-12 lg:grid-cols-2"><div className="rounded-[2rem] bg-white p-8 text-ink"><Eyebrow className="text-forest">Your guests</Eyebrow><h2 className="display-md mt-5">A charge that follows them.</h2><p className="mt-5 leading-7 text-graphite">A portable bank lets guests keep using their phones at the table, in the lobby, or on their way through a venue.</p><div className="mt-8 h-1 w-20 rounded-full bg-lime" /></div><div><Eyebrow className="text-lime">Your team</Eyebrow><h2 className="display-md mt-5">An amenity we manage.</h2><p className="mt-5 leading-7 text-white/70">The station provides self-service rentals. Zapnivo manages hardware, maintenance, software, and customer inquiries so your team can focus on your business.</p><div className="mt-8"><Button href="/business/apply">Start a conversation</Button></div></div></div></Section>
    <Section className="bg-mist"><Eyebrow className="text-forest">The partnership path</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">From first hello to a working station.</h2><div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">{PROCESS.map((item, i) => <Reveal key={item.n} delay={i * 60} className="rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest/25">{item.n}</span><h3 className="mt-12 font-display text-xl font-bold">{item.title}</h3><p className="mt-3 text-sm leading-7 text-graphite">{item.body}</p></Reveal>)}</div></Section>
    <Section><div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]"><div><Eyebrow className="text-forest">Partner questions</Eyebrow><h2 className="display-md mt-5">Let's make the details clear.</h2></div><div className="divide-y divide-mist border-t border-mist">{FAQ.map(item => <details key={item.q} className="group py-5"><summary className="flex cursor-pointer list-none justify-between gap-4 font-display text-xl font-bold marker:hidden">{item.q}<span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lime text-2xl group-open:rotate-45" aria-hidden>+</span></summary><p className="max-w-2xl pt-3 leading-7 text-graphite">{item.a}</p></details>)}</div></div></Section>
    <section className="bg-lime py-20"><div className="container-z flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><Eyebrow>Bring Zapnivo in</Eyebrow><h2 className="display-lg mt-5">Let's talk about your space.</h2></div><Button href="/business/apply" variant="dark">Apply to host a station</Button></div></section>
  </>;
}
