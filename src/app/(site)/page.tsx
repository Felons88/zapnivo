import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Button, Eyebrow, Section } from "@/components/ui";
import { HomeFaq } from "@/components/HomeFaq";
import { KioskPhoto, KioskScenePhoto } from "@/components/Photo";
import { Showcase } from "@/components/Showcase";
import { NetworkMap } from "@/components/NetworkMap";
import { getStations } from "@/lib/stations";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { VENDING_CATEGORIES } from "@/lib/vending";

export const revalidate = 300;
export async function generateMetadata(): Promise<Metadata> {
  const cms = await getPublishedContent("apex", "home");
  return {
    title: { absolute: cmsText(cms, "meta_title", "Zapnivo Vending Services | Vending Solutions in Minnesota") },
    description: cmsText(cms, "meta_description", "Explore vending solutions for Minnesota workplaces and venues, from snacks and beverages to portable charging and specialty machines."),
    alternates: { canonical: "/" },
  };
}

const industries = [
  ["Offices & workplaces", "offices", "Convenience for teams and visitors"],
  ["Hotels & hospitality", "hotels", "Amenities beyond the front desk"],
  ["Retail properties", "retail", "Options for high-traffic spaces"],
  ["Apartments", "apartments", "Everyday essentials for residents"],
  ["Entertainment venues", "entertainment", "Services for guests on the move"],
  ["Manufacturing", "warehouses", "Accessible options across shifts"],
  ["Restaurants & bars", "restaurants", "Charging and specialty opportunities"],
  ["Fitness & recreation", "fitness", "Refreshments for active visitors"],
] as const;
const images: Record<string, string> = {
  snacks: "/images/vending-snacks-concept.webp", drinks: "/images/vending-drinks-concept.webp",
  food: "/images/vending-food-concept.webp", "phone-chargers": "/images/kiosk.png",
  "trading-cards": "/images/vending-cards-concept.webp", specialty: "/images/vending-specialty-concept.webp",
};
const values = [
  ["Built around your people", "A workplace, a lobby and a gym each need something different. We begin with who uses the space."],
  ["One partner, several formats", "Snacks, drinks, food, phone charging, collectibles and specialty concepts from a single Minnesota team."],
  ["Fits the floor plan", "Footprint, power and access shape which machine goes where, so nothing is forced into a space."],
  ["Clear responsibilities", "Stocking, maintenance and support duties are written down for each location before anything is installed."],
];
const steps = [
  ["01", "Send an inquiry", "Share your address, venue type, expected traffic and the categories that interest you."],
  ["02", "Talk through options", "We follow up to discuss which equipment and product mix could suit the space."],
  ["03", "Agree on terms", "Placement terms and service responsibilities are settled in writing before any decision."],
  ["04", "Install and support", "When equipment is available, we schedule installation and start the service plan."],
];

const glance = [
  ["6", "vending categories", "Snacks to specialty"],
  ["8", "industry guides", "Workplaces to fitness"],
  ["8-slot", "charging kiosk", "First unit acquired"],
  ["MN", "home market", "Statewide inquiries"],
] as const;
const chargingSteps = [
  ["Find a station", "The map lists only verified, live stations."],
  ["Scan and rent", "Scan the kiosk QR code, review the terms, pay on your phone."],
  ["Charge on the move", "Take the power bank with you and keep using your phone."],
  ["Return it", "Dock it at any eligible participating Zapnivo station."],
] as const;
const benefits = [
  ["Snacks & drinks", "/vending/snacks", "Break-room and lobby staples"],
  ["Fresh food", "/vending/food", "Longer shifts, longer stays"],
  ["Phone charging", "/vending/phone-chargers", "Our first product line"],
  ["Collectibles", "/vending/trading-cards", "Trading cards and hobby items"],
  ["Specialty", "/vending/specialty", "Custom ideas for unusual spaces"],
] as const;

export default async function Home() {
  const [cms, stations] = await Promise.all([getPublishedContent("apex", "home"), getStations()]);
  return <>
    <section className="overflow-hidden bg-ink text-white" aria-labelledby="hero-heading">
      <div className="container-z grid min-h-[680px] items-center gap-12 pb-20 pt-40 lg:grid-cols-[.9fr_1.1fr] lg:gap-16 lg:pb-24 lg:pt-44">
        <div className="max-w-2xl">
          <Eyebrow className="text-lime">{cmsText(cms, "hero_eyebrow", "Minnesota vending services")}</Eyebrow>
          <h1 id="hero-heading" className="display-lg mt-7 !text-[clamp(3.3rem,6.2vw,6.8rem)]">{cmsText(cms, "hero_headline_a", "Smarter Vending")}{" "}<br /><span className="text-lime">{cmsText(cms, "hero_headline_b", "for Modern Spaces.")}</span></h1>
          <p className="lead mt-8 max-w-xl text-white/75">{cmsText(cms, "hero_subhead", "Zapnivo helps Minnesota businesses bring convenient snacks, beverages, portable charging, and specialty vending experiences to the people they serve.")}</p>
          <div className="mt-10 flex flex-wrap gap-3"><Button href={cmsText(cms, "hero_cta1_href", "/get-a-vending-machine")}>{cmsText(cms, "hero_cta1_label", "Request a Vending Solution")}</Button><Button href="#solutions" variant="ghost" className="border-white/40 text-white">Explore our services</Button></div>
          <p className="mt-8 text-sm text-white/60">Placement depends on location and equipment availability.</p>
        </div>
        <div className="relative min-h-[340px] overflow-hidden bg-[#d8dddf] sm:min-h-[470px] lg:h-[550px]">
          <Image src="/images/vending-office-concept.webp" alt="Illustrative concept of snack and beverage vending machines in a modern office lobby" fill priority fetchPriority="high" sizes="(min-width: 1024px) 52vw, 100vw" className="object-cover object-[65%_center]" />
          <span className="absolute bottom-4 left-4 bg-ink/90 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-white">Illustrative concept · not an installed Zapnivo location</span>
          <Link href="/vending/phone-chargers" className="absolute right-4 top-4 hidden w-36 bg-white p-2.5 text-ink shadow-2xl ring-1 ring-ink/10 transition-transform hover:-translate-y-1 sm:block"><KioskPhoto className="mx-auto h-28 w-auto object-contain" /><span className="mt-2 block text-[10px] font-bold uppercase tracking-wider text-forest">Actual Zapnivo kiosk</span><span className="mt-0.5 flex items-baseline justify-between gap-1 whitespace-nowrap text-[13px] font-bold leading-tight">Portable charging<span aria-hidden className="text-forest">→</span></span></Link>
        </div>
      </div>
    </section>

    <nav aria-label="Vending categories" className="relative border-y border-white/10 bg-[#1a1b3a] text-white"><div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-[#1a1b3a] to-transparent sm:hidden" /><div className="container-z flex gap-2 overflow-x-auto py-4 [scrollbar-width:thin] sm:flex-wrap sm:justify-center">{benefits.map(([label, href, note]) => <Link key={href} href={href} className="group flex min-h-11 shrink-0 items-center gap-3 border border-white/15 px-4 py-2 hover:border-lime hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"><span className="font-display text-sm font-bold">{label}</span><span className="hidden text-xs text-white/55 min-[1700px]:inline">{note}</span><span aria-hidden className="text-lime transition-transform group-hover:translate-x-0.5">→</span></Link>)}</div></nav>

    <section className="bg-lime text-ink" aria-label="Zapnivo at a glance"><dl className="container-z grid grid-cols-2 gap-px py-0 md:grid-cols-4">{glance.map(([big, label, sub]) => <div key={label} className="px-2 py-7 md:px-6 md:py-9"><dt className="sr-only">{label}</dt><dd><span className="block font-display text-4xl font-bold tracking-tight md:text-5xl">{big}</span><span className="mt-1 block text-sm font-bold">{label}</span><span className="block text-xs text-ink/70">{sub}</span></dd></div>)}</dl></section>

    <Section className="bg-white" id="value"><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:gap-20"><div><Eyebrow className="text-graphite">Built around your venue</Eyebrow><h2 className="display-md mt-5 max-w-xl">Convenience that works for your business.</h2></div><div className="grid gap-x-9 gap-y-9 sm:grid-cols-2">{values.map(([title, body], i) => <div key={title} className="border-t border-ink/20 pt-5"><span className="text-xs font-bold text-graphite">0{i + 1}</span><h3 className="mt-5 font-display text-xl font-bold">{title}</h3><p className="mt-3 text-sm leading-7 text-graphite">{body}</p></div>)}</div></div></Section>

    <Section className="bg-paper" id="solutions">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><Eyebrow className="text-graphite">{cmsText(cms, "solutions_eyebrow", "Vending solutions")}</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">{cmsText(cms, "solutions_title", "A better fit for every space.")}</h2></div><p className="max-w-md text-graphite">{cmsText(cms, "solutions_intro", "Explore categories that could make your workplace or venue more useful. Availability and final equipment selection depend on the location.")}</p></div>
      <div className="mt-12 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{VENDING_CATEGORIES.map(cat => <article key={cat.slug} className="group relative flex flex-col overflow-hidden border border-ink/10 bg-white focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-forest"><div className="relative aspect-[1.45] overflow-hidden bg-[#dce1e2]"><Image src={images[cat.slug]} alt={cat.slug === "phone-chargers" ? "Actual Zapnivo portable charging kiosk" : `Illustrative concept for ${cat.label.toLowerCase()}`} fill sizes="(min-width: 1280px) 32vw, (min-width: 640px) 48vw, 100vw" className={`${cat.slug === "phone-chargers" ? "object-contain p-5" : "object-cover"} transition-transform duration-500 group-hover:scale-[1.03]`} /><span className="absolute bottom-3 left-3 bg-ink/85 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">{cat.slug === "phone-chargers" ? "Actual kiosk" : "Illustrative concept"}</span></div><div className="flex flex-1 flex-col p-7"><h3 className="font-display text-2xl font-bold">{cat.label}</h3><p className="mt-3 flex-1 text-sm leading-7 text-graphite">{cat.description}</p><Link href={cat.href} className="mt-6 inline-flex min-h-11 items-center gap-2 font-bold text-ink underline decoration-ink/20 underline-offset-4 after:absolute after:inset-0 hover:decoration-ink focus-visible:outline-none">Explore {cat.shortLabel.toLowerCase()} <span aria-hidden>↗</span></Link></div></article>)}</div>
    </Section>

    <Section className="bg-white" id="industries"><div className="grid gap-7 lg:grid-cols-[.9fr_1.1fr] lg:gap-20"><div><Eyebrow className="text-graphite">Industries we serve</Eyebrow><h2 className="display-lg mt-5">Solutions shaped by the place.</h2><p className="lead mt-6 max-w-xl text-graphite">See how vending and charging can work for the kind of property you run.</p><div className="mt-8"><Button href="/get-a-vending-machine" variant="dark">Discuss your location</Button></div></div><div className="grid border-t border-ink/20 sm:grid-cols-2 sm:gap-x-8">{industries.map(([label, slug, detail]) => <Link key={slug} href={`/industries/${slug}`} className="group grid min-h-20 grid-cols-[1fr_1.5rem] items-center gap-4 border-b border-ink/15 py-4 hover:bg-mist/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"><span><strong className="block font-display text-lg">{label}</strong><span className="text-sm text-graphite">{detail}</span></span><span aria-hidden className="transition-transform group-hover:translate-x-1">↗</span></Link>)}</div></div></Section>

    <Section className="bg-[#eef0ef]" id="process"><Eyebrow className="text-graphite">How it works</Eyebrow><h2 className="display-lg mt-5 max-w-4xl">A straightforward way to bring vending to your location.</h2><div className="mt-12 grid gap-px border border-ink/15 bg-ink/15 md:grid-cols-2 xl:grid-cols-4">{steps.map(([n, title, body]) => <div key={n} className="bg-[#eef0ef] p-7 md:p-8"><span className="font-display text-3xl font-bold text-forest">{n}</span><h3 className="mt-16 font-display text-xl font-bold">{title}</h3><p className="mt-4 text-sm leading-7 text-graphite">{body}</p></div>)}</div></Section>

    <Section className="bg-paper" id="charging">
      <div className="grid items-center gap-12 lg:grid-cols-[.95fr_1.05fr] lg:gap-16">
        <div className="relative aspect-[4/3] overflow-hidden bg-[#dce1e2]"><KioskScenePhoto scene="cafe" /><span className="absolute bottom-3 left-3 bg-ink/90 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">Illustrative placement concept</span></div>
        <div><Eyebrow className="text-graphite">Portable charging</Eyebrow><h2 className="display-lg mt-5">Power for the people who visit.</h2><p className="lead mt-5 max-w-xl text-graphite">Our charger rental kiosk is our first product line. Guests rent a power bank, take it with them and return it to a participating station.</p>
          <ol className="mt-8 grid gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2">{chargingSteps.map(([t, d], i) => <li key={t} className="bg-paper p-5"><span className="font-display text-2xl font-bold text-forest">0{i + 1}</span><h3 className="mt-3 font-display text-lg font-bold">{t}</h3><p className="mt-1 text-sm leading-6 text-graphite">{d}</p></li>)}</ol>
          <div className="mt-8 flex flex-wrap gap-3"><Button href="/how-it-works" variant="dark">How charging works</Button><Button href="/locations" variant="ghost" className="border-ink/30">Find a charger</Button></div></div>
      </div>
    </Section>

    <Section dark className="bg-ink" id="technology"><Eyebrow className="text-lime">Technology & service</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Meet the hardware.</h2><p className="lead mt-5 max-w-2xl text-white/70">The real Zapnivo kiosk, from the touchscreen to the charging slots. For other vending categories, monitoring and management capabilities depend on the equipment chosen for each placement.</p><div className="mt-10"><Showcase /></div></Section>

    <Section className="bg-white" id="locations"><div className="grid gap-6 lg:grid-cols-[1fr_.7fr] lg:items-end"><div><Eyebrow className="text-graphite">Station network</Eyebrow><h2 className="display-lg mt-5">Find power near you.</h2></div><div><p className="text-graphite">Locations appear only when a station is installed, verified and live.</p><div className="mt-5"><Button href="/locations" variant="dark">Open the station map</Button></div></div></div><NetworkMap stations={stations} interactive={false} className="mt-10 h-[340px] md:h-[460px]" /></Section>

    <Section className="bg-paper" id="partners"><div className="grid gap-px bg-ink/15 lg:grid-cols-[1.15fr_.85fr]"><div className="bg-white py-2 pr-0 lg:py-4 lg:pr-14"><Eyebrow className="text-graphite">Venue partnerships</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Let’s build a better experience for your guests.</h2><p className="lead mt-6 max-w-xl text-graphite">Tell us what people need at your location and we’ll explore a vending or charging opportunity that suits it.</p><div className="mt-8"><Button href="/business/apply" variant="dark">Become a venue partner</Button></div></div><div className="bg-[#eef0ef] p-7 md:p-10"><Eyebrow className="text-graphite">Service area</Eyebrow><h3 className="display-md mt-5">Minnesota is home base.</h3><p className="mt-5 leading-7 text-graphite">Inquiries are welcome from businesses across the state. Our charger map lists only stations that are installed and verified.</p><div className="mt-7 flex flex-wrap gap-3"><Button href="/vending/locations" variant="dark">Service area</Button><Button href="/locations" variant="ghost" className="border-ink/30">Find a charger</Button></div></div></div></Section>
    <HomeFaq />
    <section className="bg-ink py-20 text-white md:py-28"><div className="container-z flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between"><div><Eyebrow className="text-lime">Start a conversation</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">{cmsText(cms, "bottom_cta_title", "Ready to bring vending to your location?")}</h2><p className="lead mt-5 max-w-2xl text-white/70">{cmsText(cms, "bottom_cta_body", "Tell us about your business and we’ll help explore vending solutions that fit your space.")}</p></div><div className="flex shrink-0 flex-wrap gap-3"><Button href="/get-a-vending-machine">Request a machine</Button><Button href="/contact" variant="ghost" className="border-white/40 text-white">Contact our team</Button></div></div></section>
  </>;
}
