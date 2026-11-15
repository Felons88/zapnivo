import type { Metadata } from "next";
import Link from "next/link";
import { Button, Eyebrow, Section } from "@/components/ui";
import { INDUSTRIES } from "./data";

export const metadata: Metadata = {
  title: { absolute: "Vending Solutions by Industry | Zapnivo" },
  description: "Explore how Zapnivo evaluates vending and portable charging opportunities for Minnesota workplaces, hospitality, retail, residential, and recreation properties.",
  alternates: { canonical: "/industries" },
};

export default function IndustriesPage() {
  return <>
    <header className="bg-ink pb-20 pt-36 text-white md:pb-28 md:pt-44">
      <div className="container-z">
        <Eyebrow className="text-lime">Industries</Eyebrow>
        <h1 className="display-lg mt-6 max-w-4xl">Vending designed around the spaces people use.</h1>
        <p className="lead mt-6 max-w-2xl text-white/75">A good placement starts with the venue. Explore considerations for your property type, then tell us about your location.</p>
        <div className="mt-9"><Button href="/vending/request">Request a vending solution</Button></div>
      </div>
    </header>
    <Section>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {INDUSTRIES.map((industry, index) => <Link key={industry.slug} href={`/industries/${industry.slug}`} className="group flex min-h-64 flex-col justify-between border border-mist bg-white p-7 transition-colors hover:border-forest hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest">
          <span className="text-sm font-bold text-forest">{String(index + 1).padStart(2, "0")} / {industry.eyebrow}</span>
          <span><span className="block font-display text-2xl font-semibold tracking-tight">{industry.name}</span><span className="mt-3 block text-sm leading-6 text-graphite">{industry.need}</span></span>
          <span className="mt-6 text-sm font-bold text-forest">Explore this industry →</span>
        </Link>)}
      </div>
    </Section>
    <Section className="bg-mist">
      <div className="grid items-end gap-8 md:grid-cols-2"><div><Eyebrow className="text-forest">Our approach</Eyebrow><h2 className="display-md mt-5">Your location sets the brief.</h2></div><div><p className="lead text-graphite">Traffic, access, available space, and the people you serve all shape the right recommendation. Placement depends on a location review and equipment availability.</p><div className="mt-7"><Button href="/vending/request" variant="dark">Discuss your location</Button></div></div></div>
    </Section>
  </>;
}
