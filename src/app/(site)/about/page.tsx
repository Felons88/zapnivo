import type { Metadata } from "next";
import Link from "next/link";
import { Button, Eyebrow, Section } from "@/components/ui";
import { KioskPhoto } from "@/components/Photo";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";

export async function generateMetadata(): Promise<Metadata> {
  const cms = await getPublishedContent("apex", "about");
  return {
    title: { absolute: cmsText(cms, "meta_title", "About Zapnivo | Minnesota Vending Services") },
    description: cmsText(cms, "meta_description", "Learn how Zapnivo approaches vending, portable charging, and equipment placement for Minnesota businesses and venues."),
    alternates: { canonical: "/about" },
  };
}

const solutions = [
  { title: "Everyday vending", body: "Snack, beverage, and food concepts shaped around the people who use your space.", href: "/vending/snacks" },
  { title: "Portable charging", body: "A self-service rental experience for guests who need power while they are out.", href: "/how-it-works" },
  { title: "Specialty formats", body: "Collectibles and other product ideas considered against the venue and available equipment.", href: "/vending/specialty" },
];

export default async function About() {
  const cms = await getPublishedContent("apex", "about");
  return <>
    <header className="bg-ink pt-32 pb-20 text-white md:pt-40 md:pb-28">
      <div className="container-z grid items-center gap-12 lg:grid-cols-[1.1fr_.9fr]">
        <div>
          <Eyebrow className="text-lime">{cmsText(cms, "hero_eyebrow", "About Zapnivo")}</Eyebrow>
          <h1 className="display-lg mt-6 max-w-3xl">{cmsText(cms, "hero_title", "A more useful everyday, one location at a time.")}</h1>
          <p className="lead mt-6 max-w-2xl text-white/75">{cmsText(cms, "hero_description", "Zapnivo Vending Services works with Minnesota businesses to explore convenient self-service vending and portable charging for the places people already visit.")}</p>
          <div className="mt-9 flex flex-wrap gap-3"><Button href="/get-a-vending-machine">Request a machine</Button><Button href="/business" variant="ghost" className="border-white/40 text-white">For businesses</Button></div>
        </div>
        <figure className="flex flex-col items-center bg-white/5 p-7 ring-1 ring-white/15">
          <KioskPhoto className="h-72 w-auto object-contain sm:h-96" />
          <figcaption className="mt-4 w-full border-t border-white/20 pt-4 text-sm text-white/70">Actual Zapnivo portable charging kiosk. Other vending categories are reviewed by location and equipment availability.</figcaption>
        </figure>
      </div>
    </header>

    <Section>
      <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:gap-20">
        <div><Eyebrow className="text-forest">Who we are</Eyebrow><h2 className="display-md mt-5">{cmsText(cms, "mission_title", "A Minnesota business focused on practical convenience.")}</h2></div>
        <div className="space-y-5 text-lg leading-8 text-graphite">
          <p>{cmsText(cms, "mission_body", "Our work starts with a simple question: what would make this particular place easier for the people who use it? A workplace may need refreshments during a long shift. A hotel may benefit from a charging option for travelers. A venue may have an entirely different product need.")}</p>
          <p>We discuss the audience, available space, access, and equipment before suggesting a solution. Every placement is reviewed individually. We publish a location as available to customers only when it is operating and verified.</p>
        </div>
      </div>
    </Section>

    <Section className="bg-mist">
      <div className="max-w-3xl"><Eyebrow className="text-forest">Our approach</Eyebrow><h2 className="display-md mt-5">Clear plans before equipment arrives.</h2><p className="lead mt-5 text-graphite">Good vending depends on the right setting, a sensible product mix, and a clear service plan. We make those decisions with the venue.</p></div>
      <div className="mt-12 grid gap-px bg-silver/70 md:grid-cols-3">
        {[
          ["01", "Understand the space", "Tell us who uses the location, where equipment could fit, and what would help them."],
          ["02", "Review the options", "We consider product categories, equipment, placement, and service needs together."],
          ["03", "Agree on a plan", "Installation and ongoing responsibilities are confirmed before a placement moves forward."],
        ].map(([number, title, body]) => <div key={number} className="bg-white p-7 md:p-9"><span className="text-sm font-bold tracking-widest text-forest">{number}</span><h3 className="mt-8 font-display text-2xl font-bold">{title}</h3><p className="mt-3 leading-7 text-graphite">{body}</p></div>)}
      </div>
    </Section>

    <Section>
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end"><div><Eyebrow className="text-forest">Our solutions</Eyebrow><h2 className="display-md mt-5">Convenience has more than one format.</h2></div><Link href="/#solutions" className="font-bold text-forest underline underline-offset-4">Explore all vending solutions →</Link></div>
      <div className="mt-10 grid gap-5 md:grid-cols-3">{solutions.map(item => <Link key={item.title} href={item.href} className="group flex min-h-64 flex-col border border-silver/60 bg-white p-7 transition-colors hover:bg-mist focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"><h3 className="font-display text-2xl font-bold">{item.title}</h3><p className="mt-4 leading-7 text-graphite">{item.body}</p><span className="mt-auto pt-7 font-bold text-forest">Learn more <span aria-hidden>↗</span></span></Link>)}</div>
    </Section>

    <Section dark>
      <div className="grid gap-12 lg:grid-cols-2 lg:items-end"><div><Eyebrow className="text-lime">Technology & service</Eyebrow><h2 className="display-md mt-5">A connected experience, with people behind it.</h2></div><div className="space-y-5 text-lg leading-8 text-white/75"><p>Our portable charging rental flow connects customers with participating stations and support. For vending placements, equipment capabilities and service arrangements are confirmed for each location.</p><p>Digital tools help us coordinate the work, but the essential promise is straightforward: a clear way to inquire, a reviewed placement plan, and support information customers can find.</p></div></div>
    </Section>

    <Section>
      <div className="grid gap-10 lg:grid-cols-[1fr_.8fr] lg:items-center"><div><Eyebrow className="text-forest">Minnesota service focus</Eyebrow><h2 className="display-md mt-5">Built around the places we can serve well.</h2><p className="lead mt-5 text-graphite">Minnesota is our primary market. Placement depends on the address, use case, equipment availability, and an agreed service plan. Tell us about your location and we will review what may fit.</p></div><div className="border-l-4 border-lime bg-mist p-7 md:p-10"><h3 className="font-display text-2xl font-bold">Work with us</h3><p className="mt-3 leading-7 text-graphite">Exploring vending for an office, hotel, property, or venue? Start with a short inquiry, or learn how a venue partnership works.</p><div className="mt-7 flex flex-wrap gap-3"><Button href="/get-a-vending-machine" variant="dark">Request a machine</Button><Button href="/business/apply" variant="ghost">Venue partnership</Button></div></div></div>
    </Section>
  </>;
}
