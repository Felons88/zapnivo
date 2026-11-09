import type { Metadata } from "next";
import { Button, Eyebrow, Notice, Section } from "@/components/ui";
import { AdvertisingForm } from "@/components/forms";
import { Reveal } from "@/components/Reveal";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskScenePhoto } from "@/components/Photo";

export const metadata: Metadata = {
  title: { absolute: "Advertise on Phone Charging Stations | Zapnivo" },
  description: "Explore advertising opportunities on Zapnivo charging stations. Inquire about screen placements, venue targeting and sponsorships.",
};

const POSSIBILITIES = [
  { t: "Screen placements", d: "Kiosk touchscreens can display content between rental interactions. Placement options depend on the final screen interface." },
  { t: "Venue targeting", d: "As the network grows, advertisers will be able to focus on venue types — nightlife, hospitality, campuses — that fit their audience." },
  { t: "Sponsorships", d: "Station-level and venue-level sponsorship possibilities will be explored with early advertising partners." },
];

export default function Advertise() {
  return (
    <>
      <MarketingHero eyebrow="Brand partnerships" title={<>Be part of the places people gather.</>} description="We're exploring advertising alongside Zapnivo's station rollout. Share your goals and we'll discuss what may become possible as capabilities are verified." actions={<><Button href="#advertising-inquiry">Start an inquiry</Button><Button href="/business" variant="ghost" className="border-white/40 text-white">Explore venue partnerships</Button></>} visual={<KioskScenePhoto scene="event" />} note="Illustrative kiosk placement · advertising is in development" />

      <Section><Eyebrow className="text-forest">What we're exploring</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">A new canvas for local attention.</h2><div className="mt-10 grid gap-4 md:grid-cols-3">{POSSIBILITIES.map((p, i) => <Reveal key={p.t} delay={i * 70} className="flex min-h-64 flex-col rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest/25">0{i + 1}</span><h3 className="mt-auto font-display text-2xl font-bold">{p.t}</h3><p className="mt-3 text-sm leading-6 text-graphite">{p.d}</p></Reveal>)}</div><div className="mt-8"><Notice title="In development:"> Advertising features are planned, not live. We cannot guarantee reach, impressions, or placements until they are verified on real hardware.</Notice></div></Section>
      <Section id="advertising-inquiry" className="bg-mist"><div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]"><div><Eyebrow className="text-forest">Your inquiry</Eyebrow><h2 className="display-md mt-5">Tell us what you have in mind.</h2><p className="lead mt-5 text-graphite">Share your audience and goals. We'll discuss options only as the network and advertising capabilities develop.</p></div><div className="rounded-xl bg-white p-6 md:p-10"><AdvertisingForm /></div></div></Section>

      <Section className="bg-mist pt-16 md:pt-16 text-center">
        <h2 className="display-md">Also interested in hosting?</h2>
        <p className="lead mx-auto mt-4 max-w-xl text-graphite">Venue partners get the amenity first — advertising is a separate program.</p>
        <div className="mt-7"><Button href="/business" variant="dark">For businesses</Button></div>
      </Section>
    </>
  );
}
