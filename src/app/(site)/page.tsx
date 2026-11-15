import type { Metadata } from "next";
import Link from "next/link";
import { Button, Eyebrow, Section } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { KioskPhoto, PowerBankPhoto } from "@/components/Photo";
import { Showcase } from "@/components/Showcase";
import { HomeFaq } from "@/components/HomeFaq";
import { NetworkMap } from "@/components/NetworkMap";
import { getStations } from "@/lib/stations";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { VENDING_CATEGORIES } from "@/lib/vending";

export const revalidate = 300;

const META_FALLBACK = {
  title: "Zapnivo Vending Services | Vending Solutions in Minnesota",
  description: "Explore Zapnivo vending solutions for Minnesota businesses, including snacks, drinks, food, portable phone charging, trading cards, and specialty machines.",
};

/** Homepage metadata — CMS-overridable via /system/sites → apex/home. */
export async function generateMetadata(): Promise<Metadata> {
  const cms = await getPublishedContent("apex", "home");
  return {
    title: { absolute: cmsText(cms, "meta_title", META_FALLBACK.title) },
    description: cmsText(cms, "meta_description", META_FALLBACK.description),
  };
}

/** Markdown-lite renderer for CMS richtext fields: **bold** only, everything else plain text. */
function rich(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part,
  );
}

const CHARGING_STEPS = [
  { n: "01", title: "Find a station", body: "Visit a participating Zapnivo location — the map shows verified live stations only." },
  { n: "02", title: "Scan and rent", body: "Scan the station QR code, review the current rental terms, and complete checkout on your phone." },
  { n: "03", title: "Charge on the move", body: "Take the released power bank with you. Keep using your phone while it charges." },
  { n: "04", title: "Return and go", body: "Dock the power bank at an eligible participating station to end your rental." },
];

export default async function Home() {
  const [stations, cms] = await Promise.all([getStations(), getPublishedContent("apex", "home")]);
  const hero = {
    eyebrow: cmsText(cms, "hero_eyebrow", "Zapnivo Vending Services · Minnesota"),
    headlineA: cmsText(cms, "hero_headline_a", "Vending Solutions"),
    headlineB: cmsText(cms, "hero_headline_b", "for Every Space."),
    subhead: cmsText(cms, "hero_subhead", "Snacks, drinks, portable phone chargers, trading cards, and specialty vending machines—all from one Minnesota-based vending service provider."),
    cta1Label: cmsText(cms, "hero_cta1_label", "Request a Vending Machine"),
    cta1Href: cmsText(cms, "hero_cta1_href", "/get-a-vending-machine"),
    cta2Label: cmsText(cms, "hero_cta2_label", "Explore Our Solutions"),
    cta2Href: cmsText(cms, "hero_cta2_href", "#solutions"),
    cta3Label: cmsText(cms, "hero_cta3_label", "Partner With Zapnivo"),
    cta3Href: cmsText(cms, "hero_cta3_href", "/business/apply"),
  };
  const solutions = {
    eyebrow: cmsText(cms, "solutions_eyebrow", "Vending solutions"),
    title: cmsText(cms, "solutions_title", "One provider. Every kind of machine."),
    intro: cmsText(cms, "solutions_intro", "Pick a category to see what we place, how machines are serviced, and what a partnership looks like. Equipment availability varies by category and location."),
  };
  const bottomCta = {
    title: cmsText(cms, "bottom_cta_title", "Want a vending machine at your business?"),
    body: cmsText(cms, "bottom_cta_body", "Tell us about your space and we'll talk through placement, equipment, and service. Now accepting vending placement inquiries across Minnesota."),
  };
  return <>
    <section className="home-hero relative overflow-hidden bg-forest text-white" aria-labelledby="hero-h">
      <div className="home-hero-grid absolute inset-0" aria-hidden />
      <div className="container-z relative grid min-h-[700px] items-center gap-8 pb-14 pt-36 lg:min-h-[760px] lg:grid-cols-[1.05fr_.95fr] lg:pb-20 lg:pt-40">
        <div className="relative z-10 max-w-3xl">
          <p className="eyebrow anim-hero text-lime">{hero.eyebrow}</p>
          <h1 id="hero-h" className="display-xl anim-hero mt-6 !text-[clamp(3rem,7.6vw,7.6rem)]" style={{ "--d": "80ms" } as React.CSSProperties}>{hero.headlineA}<br /><span className="text-lime">{hero.headlineB}</span></h1>
          <p className="lead anim-hero mt-7 max-w-xl text-white/75" style={{ "--d": "160ms" } as React.CSSProperties}>{rich(hero.subhead)}</p>
          <div className="anim-hero mt-9 flex flex-wrap gap-3" style={{ "--d": "240ms" } as React.CSSProperties}>
            <Button href={hero.cta1Href}>{hero.cta1Label}</Button>
            <Button href={hero.cta2Href} variant="ghost" className="border-white/40 text-white">{hero.cta2Label}</Button>
            <Button href={hero.cta3Href} variant="ghost" className="border-white/40 text-white">{hero.cta3Label}</Button>
          </div>
          <p className="mt-7 max-w-md text-sm text-white/55">Serving Minnesota businesses. Placement and availability depend on location and equipment.</p>
        </div>
        <div className="home-product-stage relative mx-auto flex h-[420px] w-full max-w-[600px] items-end justify-center sm:h-[540px] lg:h-[620px]">
          <div className="hero-orbit absolute bottom-[8%] left-1/2 h-[78%] w-[78%] -translate-x-1/2 rounded-full" aria-hidden />
          <div className="absolute inset-x-8 bottom-0 top-12 rounded-[45%] bg-lime/20 blur-[70px]" aria-hidden />
          <div className="absolute bottom-5 h-14 w-4/5 rounded-[50%] bg-black/40 blur-xl" aria-hidden />
          <KioskPhoto priority className="relative h-full w-auto object-contain drop-shadow-[0_35px_45px_rgba(0,0,0,.45)]" />
          <div className="absolute bottom-3 right-0 w-[35%] max-w-[190px] rotate-[-8deg] sm:right-3"><PowerBankPhoto className="h-auto w-full drop-shadow-[0_18px_25px_rgba(0,0,0,.5)]" /></div>
          <div className="hero-glow-card absolute left-0 top-[15%] hidden -rotate-6 rounded-xl px-4 py-3 text-white sm:block"><span className="block text-[10px] font-extrabold uppercase tracking-widest text-cyan">Snacks & drinks</span><strong className="mt-1 block font-display text-lg">Fresh every visit.</strong></div>
          <div className="hero-glow-card absolute right-0 top-[35%] hidden rotate-6 rounded-xl px-4 py-3 text-white sm:block"><span className="block text-[10px] font-extrabold uppercase tracking-widest text-pink">Phone charging</span><strong className="mt-1 block font-display text-lg">Power on site.</strong></div>
          <span className="absolute bottom-2 left-0 rounded-full bg-ink/80 px-3 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">Actual kiosk · representative power bank</span>
        </div>
      </div>
      <div className="relative border-t border-white/15 bg-ink/30"><div className="container-z flex flex-wrap items-center justify-between gap-3 py-4 text-xs font-extrabold uppercase tracking-[.16em] text-white/75"><span>Snack & beverage machines</span><span className="text-lime">✳</span><span>Phone charging</span><span className="text-lime">✳</span><span>Trading cards & specialty</span></div></div>
    </section>

    <Section className="section-aurora" id="solutions">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end"><div><Eyebrow className="text-forest">{solutions.eyebrow}</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">{solutions.title}</h2></div><p className="lead max-w-md text-graphite">{solutions.intro}</p></div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {VENDING_CATEGORIES.map((cat, i) => (
          <Reveal as="article" key={cat.slug} delay={i * 60} className="group flex flex-col rounded-xl border border-mist bg-white p-7 transition-transform hover:-translate-y-1">
            <span className="font-display text-5xl font-bold text-forest/15">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="mt-6 font-display text-2xl font-bold">{cat.label}</h3>
            <p className="mt-3 flex-1 text-sm leading-7 text-graphite">{cat.description}</p>
            <Link href={cat.href} className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-forest link-underline w-fit">{cat.ctaLabel}<span aria-hidden className="transition-transform group-hover:translate-x-1">→</span></Link>
          </Reveal>
        ))}
      </div>
      <div className="mt-9"><Button href="/get-a-vending-machine" variant="dark">Request a vending machine</Button></div>
    </Section>

    <Section className="section-lavender" id="customer-charging">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end"><div><Eyebrow className="text-forest">Customer charging</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Need power on the go?</h2></div><p className="lead max-w-md text-graphite">Zapnivo also runs portable charger rentals — scan a station, take a power bank with you, and return it when you're done.</p></div>
      <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{CHARGING_STEPS.map((step, i) => <Reveal as="article" key={step.n} delay={i * 60} className="home-step rounded-xl border border-mist bg-white p-7"><span className="font-display text-5xl font-bold text-forest">{step.n}</span><div className="mt-12 h-1 w-12 rounded-full bg-lime" /><h3 className="mt-5 font-display text-2xl font-bold">{step.title}</h3><p className="mt-3 text-sm leading-7 text-graphite">{step.body}</p></Reveal>)}</div>
      <div className="mt-9 flex flex-wrap gap-3"><Button href="/how-it-works" variant="dark">How charging works</Button><Button href="/locations" variant="ghost" className="border-ink/30">Find a charger</Button></div>
    </Section>

    <Section dark className="section-cinematic relative overflow-hidden">
      <div className="home-hero-grid absolute inset-0 opacity-30" aria-hidden />
      <div className="relative"><Eyebrow className="text-lime">The hardware</Eyebrow><h2 className="display-lg mt-5">Small station. Big freedom.</h2><p className="lead mt-5 max-w-2xl text-white/70">The Zapnivo kiosk holds eight power banks in a compact, self-service format. Explore the real hardware and the rental experience.</p><div className="mt-10"><Showcase /></div></div>
    </Section>

    <Section dark id="locations" className="section-cinematic overflow-hidden"><div className="grid gap-6 lg:grid-cols-[1fr_.65fr] lg:items-end"><div><Eyebrow className="text-lime">Station network</Eyebrow><h2 className="display-lg mt-5">Find power near you.</h2></div><div><p className="lead text-white/70">We publish locations when a station is installed, verified, and live. Check the map for the latest available locations.</p><div className="mt-6"><Button href="/locations">Open station map</Button></div></div></div><NetworkMap stations={stations} interactive={false} className="mt-11 h-[360px] rounded-xl md:h-[500px]" /></Section>

    <HomeFaq />

    <section className="section-neon relative overflow-hidden py-20 text-ink md:py-28"><div className="container-z relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end"><div><Eyebrow>{bottomCta.title}</Eyebrow><p className="lead mt-5 max-w-2xl">{bottomCta.body}</p></div><div className="flex flex-wrap gap-3"><Button href="/get-a-vending-machine" variant="dark">Request a machine</Button><Button href="/business/apply" variant="ghost" className="border-ink/40">Partner with Zapnivo</Button></div></div></section>
  </>;
}
