import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, Eyebrow, Section } from "@/components/ui";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { INDUSTRIES } from "../data";

type Props = { params: Promise<{ slug: string }> };
const getIndustry = (slug: string) => INDUSTRIES.find((item) => item.slug === slug);

const HERO_IMAGE: Record<string, { src: string; alt: string; actual?: boolean }> = {
  offices: { src: "/images/vending-office-concept.webp", alt: "Representative concept of snack and beverage machines in a workplace lobby" },
  hotels: { src: "/images/vending-specialty-concept.webp", alt: "Representative concept of a vending machine in a hotel lobby" },
  apartments: { src: "/images/vending-food-concept.webp", alt: "Representative concept of a food vending machine in a residential lounge" },
  retail: { src: "/images/vending-cards-concept.webp", alt: "Representative concept of a collectible vending machine in a retail setting" },
  entertainment: { src: "/images/vending-specialty-concept.webp", alt: "Representative concept of a specialty vending machine in a venue concourse" },
  warehouses: { src: "/images/vending-snacks-concept.webp", alt: "Representative concept of a snack vending machine in a break room" },
  restaurants: { src: "/images/kiosk.png", alt: "Zapnivo eight-slot portable charger rental kiosk", actual: true },
  fitness: { src: "/images/vending-drinks-concept.webp", alt: "Representative concept of a cold beverage vending machine" },
};

export function generateStaticParams() { return INDUSTRIES.map(({ slug }) => ({ slug })); }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const industry = getIndustry(slug);
  if (!industry) return {};
  const cms = await getPublishedContent("apex", `industry_${slug}`);
  return {
    title: { absolute: cmsText(cms, "meta_title", `${industry.name} Vending Solutions | Zapnivo`) },
    description: cmsText(cms, "meta_description", `${industry.intro} Explore suitable vending solutions and placement considerations in Minnesota.`),
    alternates: { canonical: `/industries/${slug}` },
  };
}

export default async function IndustryPage({ params }: Props) {
  const { slug } = await params;
  const industry = getIndustry(slug);
  if (!industry) notFound();
  const cms = await getPublishedContent("apex", `industry_${slug}`);
  const hero = HERO_IMAGE[slug];
  const eyebrow = cmsText(cms, "hero_eyebrow", industry.eyebrow);
  const headline = cmsText(cms, "hero_title", industry.headline);
  const intro = cmsText(cms, "hero_description", industry.intro);
  const editorial = cmsText(cms, "intro_body", "");
  const ctaLabel = cmsText(cms, "cta_label", "Request a vending solution");
  const ctaHref = cmsText(cms, "cta_href", `/vending/request?src=industry_${slug}`);
  const crumbs = [
    { name: "Home", href: "/" },
    { name: "Industries", href: "/industries" },
    { name: industry.name, href: `/industries/${slug}` },
  ];
  const breadcrumbJsonLd = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: `https://www.zapnivo.com${crumb.href}` })) };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }} />
    <nav aria-label="Breadcrumb" className="border-b border-mist bg-paper"><ol className="container-z flex flex-wrap gap-2 py-3 text-xs font-semibold text-graphite">{crumbs.map((crumb, index) => <li key={crumb.href} className="flex gap-2">{index > 0 && <span aria-hidden="true">/</span>}{index === crumbs.length - 1 ? <span aria-current="page" className="text-ink">{crumb.name}</span> : <Link href={crumb.href} className="hover:text-forest hover:underline">{crumb.name}</Link>}</li>)}</ol></nav>
    <header className="bg-ink pb-20 pt-32 text-white md:pb-28 md:pt-40">
      <div className="container-z grid items-center gap-12 lg:grid-cols-[1.1fr_.9fr]">
        <div><Eyebrow className="text-lime">{eyebrow}</Eyebrow><h1 className="display-lg mt-6 max-w-4xl">{headline}</h1><p className="lead mt-6 max-w-2xl text-white/75">{intro}</p><div className="mt-9 flex flex-wrap gap-3"><Button href={ctaHref}>{ctaLabel}</Button><Button href="/industries" variant="ghost" className="text-white">Explore industries</Button></div></div>
        <div className="space-y-7"><figure className="relative aspect-[4/3] overflow-hidden bg-[#dce1e2] lg:aspect-[16/10]"><Image src={hero.src} alt={hero.alt} fill priority fetchPriority="high" sizes="(min-width: 1024px) 38vw, 100vw" className={hero.actual ? "object-contain p-4" : "object-cover"} /><figcaption className="absolute bottom-3 left-3 bg-ink/90 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">{hero.actual ? "Actual Zapnivo kiosk" : "Representative concept · not an installed machine"}</figcaption></figure><div className="border-t border-white/25 pt-6"><span className="text-xs font-bold uppercase tracking-[.18em] text-lime">Location first</span><p className="mt-5 font-display text-2xl font-semibold leading-snug">{industry.need}</p><p className="mt-5 text-sm leading-6 text-white/65">Placement depends on location and equipment availability.</p></div></div>
      </div>
    </header>
    {editorial && <Section className="!py-12 md:!py-16"><p className="lead mx-auto max-w-3xl text-graphite">{editorial}</p></Section>}
    <Section>
      <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]"><div><Eyebrow className="text-forest">Suitable solutions</Eyebrow><h2 className="display-md mt-5">The right mix for this space.</h2><p className="lead mt-5 text-graphite">These are options to explore, subject to your site's needs and equipment availability.</p></div><div className="grid gap-4">{industry.services.map((service, index) => <Link key={service.href} href={service.href} className="group flex gap-5 border-b border-mist py-5 first:pt-0 hover:text-forest"><span className="pt-1 text-xs font-bold text-forest">{String(index + 1).padStart(2, "0")}</span><span className="flex-1"><span className="block font-display text-xl font-semibold">{service.label}</span><span className="mt-2 block text-sm leading-6 text-graphite">{service.why}</span></span><span aria-hidden="true" className="text-xl">↗</span></Link>)}</div></div>
    </Section>
    <Section className="bg-mist"><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]"><div><Eyebrow className="text-forest">Placement review</Eyebrow><h2 className="display-md mt-5">What we consider.</h2></div><ul className="grid gap-3 sm:grid-cols-2">{industry.considerations.map((item, index) => <li key={item} className="flex gap-4 bg-white p-5"><span className="text-sm font-bold text-forest">{String(index + 1).padStart(2, "0")}</span><span className="font-semibold">{item}</span></li>)}</ul></div></Section>
    <Section><div className="grid items-end gap-10 lg:grid-cols-[1fr_1fr]"><div><Eyebrow className="text-forest">How we work</Eyebrow><h2 className="display-md mt-5">A practical plan before placement.</h2></div><div><p className="lead text-graphite">{industry.experience}</p><p className="mt-5 text-sm leading-7 text-graphite">Tell us about the location and who uses it. We can then discuss suitable categories, access needs, and the next step. No equipment or commercial terms are promised before review.</p></div></div></Section>
    <Section className="bg-ink text-white"><div className="grid items-end gap-8 md:grid-cols-[1fr_auto]"><div><Eyebrow className="text-lime">Start a conversation</Eyebrow><h2 className="display-md mt-5">Explore vending for your {industry.name.toLowerCase()}.</h2><p className="lead mt-5 max-w-2xl text-white/75">Share your location details and interests. We’ll review the opportunity and follow up.</p></div><div><Button href={ctaHref}>{ctaLabel}</Button></div></div></Section>
  </>;
}
