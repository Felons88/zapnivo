import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Button, Eyebrow, Section } from "@/components/ui";
import { HomeFaq } from "@/components/HomeFaq";
import { KioskPhoto } from "@/components/Photo";
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
  snacks: "/images/vending-office-concept.webp", drinks: "/images/vending-office-concept.webp",
  food: "/images/vending-food-concept.webp", "phone-chargers": "/images/kiosk.png",
  "trading-cards": "/images/vending-cards-concept.webp", specialty: "/images/vending-specialty-concept.webp",
};
const values = [
  ["The right setting", "We start with your location, audience, and day-to-day needs."],
  ["More ways to serve", "Explore refreshments, charging, collectibles, and specialty concepts."],
  ["Practical placement", "Equipment, space, access, and availability are reviewed before a plan is made."],
  ["Service planning", "We discuss stocking, support, and the experience your visitors should expect."],
];
const steps = [
  ["01", "Tell us about your location", "Share your venue, audience, and the categories you have in mind."],
  ["02", "Explore the right fit", "We review the setting and discuss relevant equipment and product options."],
  ["03", "Review placement", "Together we consider space, access, power, and practical service needs."],
  ["04", "Coordinate next steps", "If the fit works, we plan placement and ongoing support together."],
];

export default async function Home() {
  const cms = await getPublishedContent("apex", "home");
  return <>
    <section className="overflow-hidden bg-ink text-white" aria-labelledby="hero-heading">
      <div className="container-z grid min-h-[680px] items-center gap-12 pb-20 pt-40 lg:grid-cols-[.9fr_1.1fr] lg:gap-16 lg:pb-24 lg:pt-44">
        <div className="max-w-2xl">
          <Eyebrow className="text-lime">{cmsText(cms, "hero_eyebrow", "Minnesota vending services")}</Eyebrow>
          <h1 id="hero-heading" className="display-lg mt-7 !text-[clamp(3.3rem,6.2vw,6.8rem)]">{cmsText(cms, "hero_headline_a", "Smarter Vending")}<br /><span className="text-lime">{cmsText(cms, "hero_headline_b", "for Modern Spaces.")}</span></h1>
          <p className="lead mt-8 max-w-xl text-white/75">{cmsText(cms, "hero_subhead", "Zapnivo helps Minnesota businesses bring convenient snacks, beverages, portable charging, and specialty vending experiences to the people they serve.")}</p>
          <div className="mt-10 flex flex-wrap gap-3"><Button href={cmsText(cms, "hero_cta1_href", "/get-a-vending-machine")}>{cmsText(cms, "hero_cta1_label", "Request a Vending Solution")}</Button><Button href="#solutions" variant="ghost" className="border-white/40 text-white">Explore our services</Button></div>
          <p className="mt-8 text-sm text-white/60">Placement is subject to location review and equipment availability.</p>
        </div>
        <div className="relative min-h-[340px] overflow-hidden bg-[#d8dddf] sm:min-h-[470px] lg:h-[550px]">
          <Image src="/images/vending-office-concept.webp" alt="Illustrative concept of snack and beverage vending machines in a modern office lobby" fill priority sizes="(min-width: 1024px) 52vw, 100vw" className="object-cover object-[65%_center]" />
          <span className="absolute bottom-4 left-4 bg-ink/90 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-white">Illustrative concept · not an installed Zapnivo location</span>
        </div>
      </div>
    </section>

    <Section className="bg-white" id="value"><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:gap-20"><div><Eyebrow className="text-graphite">Built around your venue</Eyebrow><h2 className="display-md mt-5 max-w-xl">Convenience that works for your business.</h2></div><div className="grid gap-x-9 gap-y-9 sm:grid-cols-2">{values.map(([title, body], i) => <div key={title} className="border-t border-ink/20 pt-5"><span className="text-xs font-bold text-graphite">0{i + 1}</span><h3 className="mt-5 font-display text-xl font-bold">{title}</h3><p className="mt-3 text-sm leading-7 text-graphite">{body}</p></div>)}</div></div></Section>

    <Section className="bg-paper" id="solutions">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><Eyebrow className="text-graphite">{cmsText(cms, "solutions_eyebrow", "Vending solutions")}</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">{cmsText(cms, "solutions_title", "A better fit for every space.")}</h2></div><p className="max-w-md text-graphite">{cmsText(cms, "solutions_intro", "Explore categories that could make your workplace or venue more useful. Availability and final equipment selection depend on the location.")}</p></div>
      <div className="mt-12 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{VENDING_CATEGORIES.map(cat => <article key={cat.slug} className="group flex flex-col overflow-hidden border border-ink/10 bg-white"><div className="relative aspect-[1.45] overflow-hidden bg-[#dce1e2]"><Image src={images[cat.slug]} alt={cat.slug === "phone-chargers" ? "Actual Zapnivo portable charging kiosk" : `Illustrative concept for ${cat.label.toLowerCase()}`} fill sizes="(min-width: 1280px) 32vw, (min-width: 640px) 48vw, 100vw" className={`${cat.slug === "phone-chargers" ? "object-contain p-5" : "object-cover"} transition-transform duration-500 group-hover:scale-[1.03]`} /><span className="absolute bottom-3 left-3 bg-ink/85 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">{cat.slug === "phone-chargers" ? "Actual kiosk" : "Illustrative concept"}</span></div><div className="flex flex-1 flex-col p-7"><h3 className="font-display text-2xl font-bold">{cat.label}</h3><p className="mt-3 flex-1 text-sm leading-7 text-graphite">{cat.description}</p><Link href={cat.href} className="mt-6 inline-flex min-h-11 items-center gap-2 font-bold text-ink underline decoration-ink/20 underline-offset-4 hover:decoration-ink">Explore {cat.shortLabel.toLowerCase()} <span aria-hidden>↗</span></Link></div></article>)}</div>
    </Section>

    <Section className="bg-white" id="industries"><div className="grid gap-7 lg:grid-cols-[.9fr_1.1fr] lg:gap-20"><div><Eyebrow className="text-graphite">Industries we serve</Eyebrow><h2 className="display-lg mt-5">Solutions shaped by the place.</h2><p className="lead mt-6 max-w-xl text-graphite">A workplace breakroom and a hotel lobby ask for different things. We begin with the people, the setting, and the practical details of placement.</p><div className="mt-8"><Button href="/get-a-vending-machine" variant="dark">Discuss your location</Button></div></div><div className="border-t border-ink/20">{industries.map(([label, slug, detail], i) => <Link key={slug} href={`/industries/${slug}`} className="group grid min-h-20 grid-cols-[2.5rem_1fr_1.5rem] items-center gap-4 border-b border-ink/15 py-4"><span className="text-xs font-bold text-graphite">0{i + 1}</span><span><strong className="block font-display text-lg">{label}</strong><span className="text-sm text-graphite">{detail}</span></span><span aria-hidden className="transition-transform group-hover:translate-x-1">↗</span></Link>)}</div></div></Section>

    <Section className="bg-[#eef0ef]" id="process"><Eyebrow className="text-graphite">How it works</Eyebrow><h2 className="display-lg mt-5 max-w-4xl">A straightforward way to bring vending to your location.</h2><div className="mt-12 grid gap-px border border-ink/15 bg-ink/15 md:grid-cols-2 xl:grid-cols-4">{steps.map(([n, title, body]) => <div key={n} className="bg-[#eef0ef] p-7 md:p-8"><span className="font-display text-3xl font-bold text-forest">{n}</span><h3 className="mt-16 font-display text-xl font-bold">{title}</h3><p className="mt-4 text-sm leading-7 text-graphite">{body}</p></div>)}</div></Section>

    <Section dark className="bg-ink" id="technology"><div className="grid items-center gap-12 lg:grid-cols-[1fr_.8fr]"><div><Eyebrow className="text-lime">Technology & service</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Useful technology. Thoughtful service.</h2><p className="lead mt-6 max-w-2xl text-white/70">Our portable charging experience connects a physical kiosk with a digital rental journey and support. For other vending categories, monitoring and management capabilities depend on the equipment selected for each placement.</p><div className="mt-9 flex flex-wrap gap-3"><Button href="/vending/phone-chargers">Explore phone charging</Button><Button href="/business" variant="ghost" className="border-white/40 text-white">For businesses</Button></div></div><div className="relative flex min-h-[400px] items-center justify-center bg-[#e9ebea]"><KioskPhoto className="h-[360px] w-auto object-contain" /><span className="absolute bottom-4 left-4 bg-ink px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white">Actual Zapnivo charging kiosk</span></div></div></Section>

    <Section className="bg-white" id="partners"><div className="grid items-end gap-9 lg:grid-cols-[1fr_.7fr]"><div><Eyebrow className="text-graphite">Venue partnerships</Eyebrow><h2 className="display-lg mt-5 max-w-4xl">Let’s build a better experience for your guests.</h2></div><div><p className="lead text-graphite">Tell us what people need at your location. We’ll explore the right vending or charging opportunity and review the practical details together.</p><div className="mt-8"><Button href="/business/apply" variant="dark">Become a venue partner</Button></div></div></div></Section>
    <Section className="bg-[#eef0ef]" id="service-area"><div className="grid gap-8 lg:grid-cols-[.9fr_1.1fr]"><div><Eyebrow className="text-graphite">Service area</Eyebrow><h2 className="display-md mt-5">Minnesota is home base.</h2></div><div><p className="lead text-graphite">We welcome placement inquiries from Minnesota businesses. Every opportunity is reviewed for location fit, equipment availability, and a workable service plan. Published charger locations appear on our live station map only after verification.</p><div className="mt-7 flex flex-wrap gap-3"><Button href="/vending/locations" variant="dark">Vending service area</Button><Button href="/locations" variant="ghost" className="border-ink/30">Find a charger</Button></div></div></div></Section>
    <HomeFaq />
    <section className="bg-ink py-20 text-white md:py-28"><div className="container-z flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between"><div><Eyebrow className="text-lime">Start a conversation</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">{cmsText(cms, "bottom_cta_title", "Ready to bring vending to your location?")}</h2><p className="lead mt-5 max-w-2xl text-white/70">{cmsText(cms, "bottom_cta_body", "Tell us about your business and we’ll help explore vending solutions that fit your space.")}</p></div><div className="flex shrink-0 flex-wrap gap-3"><Button href="/get-a-vending-machine">Request a machine</Button><Button href="/contact" variant="ghost" className="border-white/40 text-white">Contact our team</Button></div></div></section>
  </>;
}
