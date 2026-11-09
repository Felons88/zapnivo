import type { Metadata } from "next";
import { Badge, Button, Eyebrow, Notice, Section } from "@/components/ui";
import { MarketingHero } from "@/components/MarketingHero";
import { RentalWalkthrough } from "@/components/RentalWalkthrough";
import { ScenePhoto } from "@/components/Photo";
import { fmt, PRICING_V1 } from "@/lib/pricing";

export const metadata: Metadata = { title: "How Rentals Work", description: "Learn how to find a Zapnivo station, rent a portable power bank, charge on the move, and return it." };
const P = PRICING_V1;
const ROWS = [
  { label: "First started hour", value: fmt(P.firstHourCents) },
  { label: "Each additional started hour", value: fmt(P.additionalHourCents) },
  { label: "Maximum for the first 24 hours", value: fmt(P.first24hCapCents) },
  { label: `Non-return maximum after ${P.nonReturnAfterHours} hours`, value: fmt(P.nonReturnMaxCents) },
];

export default function HowItWorks() {
  return <>
    <MarketingHero eyebrow="The rental experience" title={<>Charge on your terms.</>} description="Four clear steps take you from a low battery to power you can carry. Review the current price before you start and return the bank to an eligible station when you're done." actions={<><Button href="/locations">Find a station</Button><Button href="#rental-steps" variant="ghost" className="border-white/40 text-white">Explore the steps</Button></>} visual={<ScenePhoto scene="cafe" />} note="Illustrative render · café setting" />
    <Section id="rental-steps"><div className="mb-10"><Eyebrow className="text-forest">Step by step</Eyebrow><h2 className="display-lg mt-5 max-w-3xl">From scan to return.</h2></div><RentalWalkthrough /></Section>
    <Section className="bg-mist">
      <div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr]">
        <div><Eyebrow className="text-forest">Rental pricing</Eyebrow><h2 className="display-lg mt-5">Know before you go.</h2><p className="lead mt-6 text-graphite">The rate shown at checkout is the rate that matters. Pilot figures below are proposed and will be finalized before rentals go live.</p><div className="mt-6"><Badge tone="amber">Proposed pilot pricing</Badge></div><div className="mt-6"><Notice title="Final pricing pending.">These figures may change. Applicable taxes are added at checkout; a temporary payment authorization may apply.</Notice></div></div>
        <div className="overflow-hidden rounded-xl bg-white"><div className="bg-forest p-6 text-white"><span className="eyebrow text-lime">Current proposal</span><h3 className="mt-3 font-display text-2xl font-bold">Portable power, measured by time.</h3></div><dl>{ROWS.map((row) => <div key={row.label} className="flex items-baseline justify-between gap-5 border-b border-mist px-6 py-5 last:border-0"><dt className="text-graphite">{row.label}</dt><dd className="shrink-0 font-display text-2xl font-bold">{row.value}</dd></div>)}</dl><p className="px-6 pb-6 text-xs leading-5 text-graphite">Daily pricing after the first 24 hours is being finalized. The non-return charge applies according to the terms shown at checkout.</p></div>
      </div>
    </Section>
    <Section dark><div className="grid gap-8 lg:grid-cols-3"><div><Eyebrow className="text-lime">Good to know</Eyebrow><h2 className="display-md mt-5">Built for an easy return.</h2></div>{[{ t: "Eligible stations", d: "Your rental confirmation identifies where your bank can be returned. Check before traveling to a different station." }, { t: "Need a hand?", d: "Keep your rental reference if a bank does not dispense or a return is not recognized. Support can investigate station records." }].map(item => <div key={item.t} className="rounded-xl bg-white/5 p-7"><h3 className="font-display text-2xl font-bold">{item.t}</h3><p className="mt-4 leading-7 text-white/70">{item.d}</p></div>)}</div><div className="mt-10 flex flex-wrap gap-3"><Button href="/support">Visit support</Button><Button href="/legal/rental-terms" variant="ghost" className="border-white/40 text-white">Read rental terms</Button></div></Section>
  </>;
}
