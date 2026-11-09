import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { TicketForm } from "@/components/forms";
import { MarketingHero } from "@/components/MarketingHero";

export const metadata: Metadata = {
  title: "Create a Support Ticket",
  description: "Get help with a Zapnivo rental, return, billing issue or damaged charger. Describe the issue and we'll investigate.",
  robots: { index: false, follow: false },
};

const clip = (v: string | string[] | undefined, n: number) => (Array.isArray(v) ? v[0] : v)?.slice(0, n);

export default async function NewTicket({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const defaults = { category: clip(sp.category, 60), rentalRef: clip(sp.rental, 20), station: clip(sp.station, 160) };
  return (
    <>
      <MarketingHero eyebrow="Support request" title={<>Let's sort this out.</>} description="Tell us what happened with your rental, return, or charge. Your reference, station, and approximate time help us investigate." actions={<><Button href="#ticket-form">Open ticket form</Button><Button href="/support#find-rental" variant="ghost" className="border-white/40 text-white">Find my rental first</Button></>} />
      <Section id="ticket-form" className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]"><div><Eyebrow className="text-forest">Before you submit</Eyebrow><h2 className="display-md mt-5">Details help us help you.</h2><ul className="mt-6 space-y-3">{["Rental reference (ZR-XXXXXXXX), if available", "Station or venue", "Approximate date and time", "A short description of what happened"].map(item => <li key={item} className="flex gap-3 rounded-lg bg-white p-4"><span className="font-bold text-forest" aria-hidden>✓</span>{item}</li>)}</ul><p className="mt-6 text-sm text-graphite">Never include your full card number, CVV, or password.</p></div><div className="rounded-xl bg-white p-6 md:p-10"><TicketForm defaults={defaults} /></div></div>
      </Section>
    </>
  );
}
