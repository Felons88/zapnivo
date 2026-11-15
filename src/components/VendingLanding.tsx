import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Eyebrow, Section } from "./ui";
import { Reveal } from "./Reveal";
import { MarketingHero } from "./MarketingHero";
import { VendingCategoryVisual } from "./VendingCategoryVisual";
import { VendingCategoryDetails } from "./VendingCategoryDetails";
import type { VendingPageContent } from "@/lib/vending-content";

/**
 * Shared layout for every Zapnivo Vending Services landing page.
 * Server component — pages resolve CMS overrides into `category` before
 * passing it here. `children` fills the inquiry/contact slot at the bottom.
 */

export type VendingStep = { title: string; body: string };

/** Markdown-lite renderer for CMS richtext fields: **bold** only, everything else plain text. */
function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function Breadcrumbs({ label }: { label: string }) {
  const items = [
    { name: "Home", href: "/" },
    { name: "Vending Services", href: "/vending/locations" },
    { name: label, href: undefined as string | undefined },
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      ...(item.href ? { item: `https://zapnivo.com${item.href}` } : {}),
    })),
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <nav aria-label="Breadcrumb" className="border-b border-mist bg-paper">
        <ol className="container-z flex flex-wrap items-center gap-2 py-3 text-xs font-bold text-graphite">
          {items.map((item, i) => (
            <li key={item.name} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="text-mist">/</span>}
              {item.href ? (
                <Link href={item.href} className="hover:text-ink hover:underline underline-offset-4">{item.name}</Link>
              ) : (
                <span aria-current="page" className="text-ink">{item.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

export default function VendingLanding({
  category,
  ctaHref,
  ctaLabel,
  introBody = "",
  steps,
  visual,
  children,
}: {
  category: VendingPageContent;
  ctaHref: string;
  ctaLabel: string;
  /** Optional CMS richtext paragraph rendered under the hero (**bold** supported). */
  introBody?: string;
  /** Optional numbered process (e.g. the placement flow on request pages). */
  steps?: VendingStep[];
  visual?: ReactNode;
  /** Inquiry/contact slot rendered near the bottom of the page. */
  children?: ReactNode;
}) {
  return (
    <>
      <Breadcrumbs label={category.label} />

      <MarketingHero
        eyebrow={category.eyebrow}
        title={category.title}
        description={category.overview}
        actions={
          <>
            <Button href={ctaHref}>{ctaLabel}</Button>
            <Button href={category.slug === "phone-chargers" ? "/locations" : "/industries"} variant="ghost" className="border-white/40 text-white">{category.slug === "phone-chargers" ? "Find a charger" : "Explore industries"}</Button>
          </>
        }
        visual={visual ?? <VendingCategoryVisual slug={category.slug} />}
        note={category.slug === "phone-chargers" || category.slug === "locations" ? "Illustrative placement concept · Minnesota" : "Solutions subject to location and equipment review"}
      />

      {introBody.trim() !== "" && (
        <Section className="!py-12 md:!py-16">
          <div className="mx-auto max-w-3xl">
            <p className="lead text-graphite">{rich(introBody)}</p>
          </div>
        </Section>
      )}

      <VendingCategoryDetails slug={category.slug} />

      <Section>
        <Eyebrow className="text-forest">Where it fits</Eyebrow>
        <h2 className="display-lg mt-5 max-w-3xl">Suitable locations.</h2>
        <p className="lead mt-5 max-w-2xl text-graphite">{category.tagline} Placement is reviewed per venue — these are the kinds of spaces we typically explore.</p>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {category.suitableLocations.map((place, i) => (
            <Reveal key={place} delay={i * 40} className="flex items-center gap-3 rounded-xl border border-mist bg-white p-5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lime font-display text-sm font-bold text-ink" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
              <span className="text-sm font-bold">{place}</span>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <Eyebrow className="text-forest">For venue owners</Eyebrow>
            <h2 className="display-md mt-5">Why hosts work with Zapnivo.</h2>
            <p className="lead mt-5 text-graphite">A self-service amenity for your guests — with honest terms reviewed before anything is installed.</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {category.ownerBenefits.map((benefit) => (
              <li key={benefit} className="flex items-start gap-3 rounded-xl bg-white p-4 text-sm font-bold leading-6 text-ink">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-lime text-ink" aria-hidden>✓</span>
                {benefit}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {steps && steps.length > 0 && (
        <Section>
          <Eyebrow className="text-forest">How placement works</Eyebrow>
          <h2 className="display-lg mt-5 max-w-3xl">From inquiry to installation.</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step, i) => (
              <Reveal key={step.title} as="article" delay={i * 60} className="rounded-xl border border-mist bg-white p-7">
                <span className="font-display text-5xl font-bold text-forest">{String(i + 1).padStart(2, "0")}</span>
                <div className="mt-10 h-1 w-12 rounded-full bg-lime" />
                <h3 className="mt-5 font-display text-xl font-bold">{step.title}</h3>
                <p className="mt-3 text-sm leading-7 text-graphite">{step.body}</p>
              </Reveal>
            ))}
          </div>
        </Section>
      )}

      <Section>
        <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <Eyebrow className="text-forest">Questions</Eyebrow>
            <h2 className="display-md mt-5">Common questions.</h2>
            <p className="lead mt-5 text-graphite">Straight answers about vending, placement, and service.</p>
          </div>
          <div className="space-y-3">
            {category.faqs.map((faq) => (
              <details key={faq.q} className="group rounded-xl border border-mist bg-white p-5 open:shadow-sm">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-bold">
                  {faq.q}
                  <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mist text-ink transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-7 text-graphite">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </Section>

      {category.relatedLinks.length > 0 && (
        <Section className="!pt-0">
          <Eyebrow className="text-forest">Keep exploring</Eyebrow>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {category.relatedLinks.map((link) => (
              <Link key={link.href + link.label} href={link.href} className="group rounded-xl border border-mist bg-white p-6 transition-shadow hover:shadow-md">
                <h3 className="font-display text-lg font-bold group-hover:text-forest">{link.label}</h3>
                <p className="mt-2 text-sm leading-6 text-graphite">{link.description}</p>
                <span className="mt-4 inline-block text-sm font-bold text-forest">Learn more →</span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section id="vending-inquiry" className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]">
          <div>
            <Eyebrow className="text-forest">Next step</Eyebrow>
            <h2 className="display-md mt-5">Interested in {category.label.toLowerCase()}?</h2>
            <p className="lead mt-5 text-graphite">Tell us about your space and we'll review what fits — placement and availability depend on location and equipment.</p>
            <div className="mt-7"><Button href={category.slug === "request" ? "#vending-inquiry" : "/vending/request"} variant="dark">{category.slug === "request" ? "Go to the inquiry form" : "Request a vending machine"}</Button></div>
          </div>
          <div className="rounded-xl bg-white p-6 md:p-10">
            {children ?? (
              <div className="flex h-full flex-col items-start justify-center gap-4">
                <p className="text-sm leading-7 text-graphite">Use the request form to share your location details, or reach us through the contact page and we'll point you to the right conversation.</p>
                <Button href="/contact" variant="ghost">Contact Zapnivo</Button>
              </div>
            )}
          </div>
        </div>
      </Section>
    </>
  );
}
