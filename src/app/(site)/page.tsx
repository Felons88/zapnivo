import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { KioskPhoto, PowerBankPhoto, ScenePhoto, KioskScenePhoto } from "@/components/Photo";
import { Showcase } from "@/components/Showcase";
import { RentalGuide } from "@/components/RentalGuide";
import { HomeFaq } from "@/components/HomeFaq";
import { NetworkMap } from "@/components/NetworkMap";
import { getStations } from "@/lib/stations";
import { IllustrativeTag } from "@/components/Illustrations";

export const metadata: Metadata = {
  title: { absolute: "Portable Phone Charger Rentals | Zapnivo" },
  description: "Rent a portable power bank from a Zapnivo station, charge while you move, and return it to an eligible participating station. Explore rentals and venue partnerships in Minnesota.",
};

const STEPS = [
  { n: "01", title: "Find a station", body: "Visit a participating Zapnivo location. Stations are added to our map only after they are verified and live." },
  { n: "02", title: "Scan and rent", body: "Scan the station QR code, review the current rental terms and complete checkout on your phone." },
  { n: "03", title: "Charge on the move", body: "Take the released power bank with you. Keep using your phone while it charges." },
  { n: "04", title: "Return and go", body: "Dock the power bank at an eligible participating station to end your rental." },
];
const PLACES = ["Bars & nightlife", "Restaurants & cafés", "Hotels", "Shopping centers", "Campuses", "Events & venues"];
const PLACE_SCENES = ["bar", "cafe", "hotel", "shopping", "campus", "event"] as const;

export default async function Home() {
  const stations = await getStations();
  return <>
    <section className="home-hero relative overflow-hidden bg-forest text-white" aria-labelledby="hero-h">
      <div className="home-hero-grid absolute inset-0" aria-hidden />
      <div className="container-z relative grid min-h-[700px] items-center gap-8 pb-14 pt-36 lg:min-h-[760px] lg:grid-cols-[1.05fr_.95fr] lg:pb-20 lg:pt-40">
        <div className="relative z-10 max-w-3xl">
          <p className="eyebrow anim-hero text-lime">Portable power, wherever life takes you</p>
          <h1 id="hero-h" className="display-xl anim-hero mt-6 !text-[clamp(3rem,7.6vw,7.6rem)]" style={{ "--d": "80ms" } as React.CSSProperties}>Life moves.<br /><span className="text-lime">Power follows.</span></h1>
          <p className="lead anim-hero mt-7 max-w-xl text-white/75" style={{ "--d": "160ms" } as React.CSSProperties}>Zapnivo provides self-service portable phone charger rentals. Scan a station, take a power bank with you, and return it to any eligible participating station — no outlet required.</p>
          <div className="anim-hero mt-9 flex flex-wrap gap-3" style={{ "--d": "240ms" } as React.CSSProperties}>
            <Button href="/locations">Find a station</Button>
            <Button href="/how-it-works" variant="ghost" className="border-white/40 text-white">See how rentals work</Button>
          </div>
          <p className="mt-7 max-w-md text-sm text-white/55">Rolling out first in St. Cloud and across Minnesota. The station map shows verified live locations only.</p>
        </div>
        <div className="home-product-stage relative mx-auto flex h-[420px] w-full max-w-[600px] items-end justify-center sm:h-[540px] lg:h-[620px]">
          <div className="hero-orbit absolute bottom-[8%] left-1/2 h-[78%] w-[78%] -translate-x-1/2 rounded-full" aria-hidden />
          <div className="absolute inset-x-8 bottom-0 top-12 rounded-[45%] bg-lime/20 blur-[70px]" aria-hidden />
          <div className="absolute bottom-5 h-14 w-4/5 rounded-[50%] bg-black/40 blur-xl" aria-hidden />
          <KioskPhoto priority className="relative h-full w-auto object-contain drop-shadow-[0_35px_45px_rgba(0,0,0,.45)]" />
          <div className="absolute bottom-3 right-0 w-[35%] max-w-[190px] rotate-[-8deg] sm:right-3"><PowerBankPhoto className="h-auto w-full drop-shadow-[0_18px_25px_rgba(0,0,0,.5)]" /></div>
          <div className="hero-glow-card absolute left-0 top-[15%] hidden -rotate-6 rounded-xl px-4 py-3 text-white sm:block"><span className="block text-[10px] font-extrabold uppercase tracking-widest text-cyan">The rental</span><strong className="mt-1 block font-display text-lg">Scan. Go. Charge.</strong></div>
          <div className="hero-glow-card absolute right-0 top-[35%] hidden rotate-6 rounded-xl px-4 py-3 text-white sm:block"><span className="block text-[10px] font-extrabold uppercase tracking-widest text-pink">The return</span><strong className="mt-1 block font-display text-lg">Dock when done.</strong></div>
          <span className="absolute bottom-2 left-0 rounded-full bg-ink/80 px-3 py-1 text-[10px] font-extrabold uppercase tracking-widest text-lime">Actual kiosk · representative power bank</span>
        </div>
      </div>
      <div className="relative border-t border-white/15 bg-ink/30"><div className="container-z flex flex-wrap items-center justify-between gap-3 py-4 text-xs font-extrabold uppercase tracking-[.16em] text-white/75"><span>Scan to rent</span><span className="text-lime">✳</span><span>Charge as you go</span><span className="text-lime">✳</span><span>Return to an eligible station</span></div></div>
    </section>

    <Section className="section-aurora" id="how-rentals-work">
      <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end"><div><Eyebrow className="text-forest">How it works</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Power for the whole plan.</h2></div><p className="lead max-w-md text-graphite">A simple rental flow built for nights out, long days, and everything between.</p></div>
      <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{STEPS.map((step, i) => <Reveal as="article" key={step.n} delay={i * 60} className="home-step rounded-xl border border-mist bg-white p-7"><span className="font-display text-5xl font-bold text-forest/25">{step.n}</span><div className="mt-12 h-1 w-12 rounded-full bg-lime" /><h3 className="mt-5 font-display text-2xl font-bold">{step.title}</h3><p className="mt-3 text-sm leading-7 text-graphite">{step.body}</p></Reveal>)}</div>
      <div className="mt-9"><Button href="/how-it-works" variant="dark">Explore the rental process</Button></div>
    </Section>

    <Section className="section-lavender">
      <div className="mb-10 flex flex-col gap-5 md:flex-row md:items-end md:justify-between"><div><Eyebrow className="text-forest">Why portable power</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Your phone moves.<br />Your charger should too.</h2></div><p className="lead max-w-md text-graphite">Keep charging at the table, on the floor, or on your way out. The power bank goes with you.</p></div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <div className="relative flex min-h-[430px] overflow-hidden rounded-[2rem] bg-forest p-7 text-white sm:p-10">
          <ScenePhoto scene="cafe" className="object-center" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink/95 via-ink/65 to-ink/5" aria-hidden />
          <div className="relative z-10 flex max-w-sm flex-col"><span className="eyebrow text-cyan">No wall outlet required</span><h3 className="display-md mt-5">Stay in the moment.</h3><p className="mt-4 leading-7 text-white/80">Rent a power bank at the station and carry the charge into the rest of your day.</p><div className="mt-auto pt-8"><Button href="/how-it-works">Explore rentals</Button></div></div>
          <div className="absolute bottom-4 right-4"><IllustrativeTag light /></div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <div className="relative flex min-h-48 overflow-hidden rounded-[2rem] bg-cyan p-7 text-ink"><div><span className="eyebrow">01 / Pick up</span><h3 className="mt-4 max-w-48 font-display text-2xl font-bold">Rent at a station.</h3></div><span className="absolute -bottom-10 -right-6 font-display text-[12rem] font-bold leading-none text-ink/10" aria-hidden>↗</span></div>
          <div className="relative flex min-h-48 overflow-hidden rounded-[2rem] bg-pink p-7 text-ink"><div><span className="eyebrow">02 / Drop off</span><h3 className="mt-4 max-w-52 font-display text-2xl font-bold">Return when you&apos;re done.</h3></div><span className="absolute -bottom-12 -right-3 font-display text-[12rem] font-bold leading-none text-ink/10" aria-hidden>⌄</span></div>
        </div>
      </div>
    </Section>

    <Section dark className="section-cinematic relative overflow-hidden">
      <div className="home-hero-grid absolute inset-0 opacity-30" aria-hidden />
      <div className="relative"><Eyebrow className="text-lime">The hardware</Eyebrow><h2 className="display-lg mt-5">Small station. Big freedom.</h2><p className="lead mt-5 max-w-2xl text-white/70">The Zapnivo kiosk holds eight power banks in a compact, self-service format. Explore the real hardware and the rental experience.</p><div className="mt-10"><Showcase /></div></div>
    </Section>

    <Section className="section-lavender" id="for-venues">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div className="relative min-h-[440px] overflow-hidden rounded-[2rem] bg-forest sm:min-h-[560px]"><KioskScenePhoto scene="bar" className="object-[60%_center]" /><div className="absolute bottom-4 left-4"><IllustrativeTag light /></div></div>
        <div><Eyebrow className="text-forest">For venues</Eyebrow><h2 className="display-lg mt-5">Make charging part of the experience.</h2><p className="lead mt-6 text-graphite">Give guests a way to charge without staying beside an outlet. Zapnivo handles the equipment, servicing, software, and rental support.</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">{["Self-service rentals", "Compact counter footprint", "Zapnivo-managed servicing", "Customer support covered"].map(item => <div key={item} className="flex items-center gap-3 rounded-lg bg-white p-4 text-sm font-bold"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lime" aria-hidden>✓</span>{item}</div>)}</div>
          <div className="mt-9 flex flex-wrap gap-3"><Button href="/business/apply" variant="dark">Request a partnership</Button><Button href="/business" variant="ghost" className="border-ink/30">How hosting works</Button></div>
        </div>
      </div>
    </Section>

    <Section className="section-aurora"><div className="grid gap-8 lg:grid-cols-[.9fr_1.1fr] lg:items-end"><div><Eyebrow className="text-forest">Made for real places</Eyebrow><h2 className="display-lg mt-5">A better amenity for where people gather.</h2></div><p className="lead max-w-xl text-graphite">From a quick stop to an all-night event, guests can take a charger with them as they move through your space. Placement is planned with each venue.</p></div><div className="mt-11 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{PLACES.map((place, i) => <Reveal key={place} delay={i * 50} className="venue-card group flex min-h-64 items-end justify-between overflow-hidden rounded-xl p-6 text-white transition-transform hover:-translate-y-1"><KioskScenePhoto scene={PLACE_SCENES[i]} className="object-[60%_center]" /><div className="absolute inset-0 bg-gradient-to-t from-ink/95 via-ink/10 to-transparent" aria-hidden /><span className="absolute right-4 top-1 font-display text-7xl font-bold text-white/20" aria-hidden>{String(i + 1).padStart(2, "0")}</span><h3 className="relative font-display text-2xl font-bold">{place}</h3><span className="relative grid h-10 w-10 place-items-center rounded-full bg-lime text-ink transition-transform group-hover:rotate-45" aria-hidden>↗</span><span className="absolute left-6 top-5 rounded-full bg-ink/75 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-white">Illustrative render</span></Reveal>)}</div></Section>

    <RentalGuide />

    <Section dark id="locations" className="section-cinematic overflow-hidden"><div className="grid gap-6 lg:grid-cols-[1fr_.65fr] lg:items-end"><div><Eyebrow className="text-lime">Station network</Eyebrow><h2 className="display-lg mt-5">Find power near you.</h2></div><div><p className="lead text-white/70">We publish locations when a station is installed, verified, and live. Check the map for the latest available locations.</p><div className="mt-6"><Button href="/locations">Open station map</Button></div></div></div><NetworkMap stations={stations} interactive={false} className="mt-11 h-[360px] rounded-xl md:h-[500px]" /></Section>

    <HomeFaq />

    <section className="section-neon relative overflow-hidden py-20 text-ink md:py-28"><div className="container-z relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end"><div><Eyebrow>Stay charged</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">Life moves.<br />Power follows.</h2></div><div className="flex flex-wrap gap-3"><Button href="/locations" variant="dark">Find a station</Button><Button href="/business/apply" variant="ghost" className="border-ink/40">Bring Zapnivo to your venue</Button></div></div></section>
  </>;
}
