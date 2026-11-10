import type { Metadata } from "next";
import Link from "next/link";
import { Button, Eyebrow, Notice, Section } from "@/components/ui";
import { AdvertisingForm } from "@/components/forms";
import { Reveal } from "@/components/Reveal";
import { MarketingHero } from "@/components/MarketingHero";
import { KioskScenePhoto } from "@/components/Photo";
import { listRateCards, type AdRateCard } from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "Advertise on Phone Charging Stations | Zapnivo" },
  description: "Explore advertising opportunities on Zapnivo charging stations. Inquire about screen placements, venue targeting and sponsorships.",
};

const POSSIBILITIES = [
  { t: "Screen placements", d: "Kiosk touchscreens can display content between rental interactions. Placement options depend on the final screen interface." },
  { t: "Venue targeting", d: "As the network grows, advertisers will be able to focus on venue types — nightlife, hospitality, campuses — that fit their audience." },
  { t: "Sponsorships", d: "Station-level and venue-level sponsorship possibilities will be explored with early advertising partners." },
];

const PLACEMENT_LABEL: Record<string, string> = { kiosk_screen: "Kiosk screens", website: "Website", email: "Email", event: "Events" };
const MODEL_LABEL: Record<string, string> = { fixed: "fixed flight", cpm: "per 1,000 impressions", cpc: "per click" };
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export default async function Advertise() {
  const db = serviceClient();
  const cards: AdRateCard[] = db ? await listRateCards(db) : [];
  return (
    <>
      <MarketingHero eyebrow="Brand partnerships" title={<>Be part of the places people gather.</>} description="We're exploring advertising alongside Zapnivo's station rollout. Share your goals and we'll discuss what may become possible as capabilities are verified." actions={<><Button href="#advertising-inquiry">Start an inquiry</Button><Button href="/business" variant="ghost" className="border-white/40 text-white">Explore venue partnerships</Button></>} visual={<KioskScenePhoto scene="event" />} note="Illustrative kiosk placement · advertising is in development" />

      <Section><Eyebrow className="text-forest">What we're exploring</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">A new canvas for local attention.</h2><div className="mt-10 grid gap-4 md:grid-cols-3">{POSSIBILITIES.map((p, i) => <Reveal key={p.t} delay={i * 70} className="flex min-h-64 flex-col rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest">0{i + 1}</span><h3 className="mt-auto font-display text-2xl font-bold">{p.t}</h3><p className="mt-3 text-sm leading-6 text-graphite">{p.d}</p></Reveal>)}</div><div className="mt-8"><Notice title="In development:"> Advertising features are planned, not live. We cannot guarantee reach, impressions, or placements until they are verified on real hardware.</Notice></div></Section>

      <Section className="bg-mist pt-16 md:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <Eyebrow className="justify-center text-forest">Self-serve</Eyebrow>
          <h2 className="display-md mt-5">Already an advertiser?</h2>
          <p className="lead mx-auto mt-4 max-w-xl text-graphite">Sign in to your dashboard to build campaigns, upload creatives and track review status. Self-serve campaigns are launching soon — until then, our team sets everything up with you.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button href="/advertiser">Advertiser dashboard</Button>
            <Button href="/login" variant="ghost">Sign in</Button>
          </div>
        </div>
      </Section>

      {cards.length > 0 && (
        <Section>
          <Eyebrow className="text-forest">Current rate card</Eyebrow>
          <h2 className="display-md mt-5">Published pricing.</h2>
          <div className="mt-8 overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Placement", "Pricing", "Unit", "Minimum", "Duration"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id} className="border-b border-mist/70 last:border-0">
                    <td className="px-4 py-3 font-bold">{PLACEMENT_LABEL[c.placement] ?? c.placement}</td>
                    <td className="px-4 py-3 text-graphite">{MODEL_LABEL[c.pricing_model] ?? c.pricing_model}</td>
                    <td className="px-4 py-3">{money(c.unit_price_cents)}</td>
                    <td className="px-4 py-3">{money(c.min_spend_cents)}</td>
                    <td className="px-4 py-3 text-graphite">{c.duration_days} days</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section id="advertising-inquiry" className="bg-mist"><div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]"><div><Eyebrow className="text-forest">Your inquiry</Eyebrow><h2 className="display-md mt-5">Tell us what you have in mind.</h2><p className="lead mt-5 text-graphite">Share your audience and goals. We'll discuss options only as the network and advertising capabilities develop.</p></div><div className="rounded-xl bg-white p-6 md:p-10"><AdvertisingForm /></div></div></Section>

      <Section className="bg-mist pt-16 md:pt-16 text-center">
        <h2 className="display-md">Also interested in hosting?</h2>
        <p className="lead mx-auto mt-4 max-w-xl text-graphite">Venue partners get the amenity first — advertising is a separate program.</p>
        <div className="mt-7"><Button href="/business" variant="dark">For businesses</Button></div>
      </Section>
    </>
  );
}
