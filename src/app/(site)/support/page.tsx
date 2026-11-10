import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, Section } from "@/components/ui";
import { HelpCenter } from "@/components/HelpCenter";
import { SupportTools } from "@/components/SupportTools";
import { AssistantChat } from "@/components/AssistantChat";
import { fmt, PRICING_V1 } from "@/lib/pricing";
import { OpenAssistant } from "@/components/OpenAssistant";
import type { Audience } from "@/lib/support-content";
import { subUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Phone Charger Rental Support | Zapnivo" },
  description: "Zapnivo help center for renters and venue partners: find a past rental, request a refund review, track a ticket, and search answers about rentals, returns and billing.",
  alternates: { canonical: subUrl("support", "/") },
};

const P = PRICING_V1;
const QUICK = [
  { n: "01", t: "Find my rental", d: "Look up a past rental by reference, or by date and station.", href: "#find-rental" },
  { n: "02", t: "Request a refund", d: "Start a refund review for a failed dispense or a wrong charge.", href: "/support/new?category=Refund%20request" },
  { n: "03", t: "Report a problem", d: "Didn't dispense, return not recognized, or a damaged charger.", href: "/support/new" },
  { n: "04", t: "Venue partner help", d: "Hosting, service and payout questions for partners.", href: "/contact?topic=partnerships" },
];

export default async function Support({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  const { audience } = await searchParams;
  const initial: Audience = audience === "venue" ? "venue" : "renter";
  return (
    <HelpCenter initialAudience={initial} before={<>
      <section className="relative z-10 -mt-10 pb-6" aria-label="Quick actions">
        <div className="container-z grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK.map((q) => (
            <Link key={q.n} href={q.href} className="home-step group flex min-h-44 flex-col rounded-xl border border-mist bg-white p-6 shadow-lg">
              <span className="font-display text-3xl font-bold text-forest">{q.n}</span>
              <span className="mt-auto font-display text-xl font-bold">{q.t}</span>
              <span className="mt-1 text-sm text-graphite">{q.d}</span>
              <span className="mt-3 text-xs font-extrabold uppercase tracking-widest text-forest">Go <span className="inline-block transition-transform group-hover:translate-x-1" aria-hidden>→</span></span>
            </Link>
          ))}
        </div>
      </section>

      <SupportTools />
      </>} after={<>
      <Section className="section-aurora">
        <div className="grid gap-10 lg:grid-cols-[.9fr_1.1fr] lg:items-center">
          <div>
            <Eyebrow className="text-forest">The rental terms at a glance</Eyebrow>
            <h2 className="display-lg mt-5">What a rental costs.</h2>
            <p className="lead mt-5 text-graphite">Every answer here follows these rules. The rate shown at checkout is the rate that applies. Figures are proposed pilot pricing and may change before launch.</p>
            <div className="mt-7 flex flex-wrap gap-3 text-sm font-bold"><Link href="/how-it-works" className="underline underline-offset-4">How rentals work →</Link><Link href="/legal/rental-terms" className="underline underline-offset-4">Rental terms →</Link><Link href="/legal/refund-policy" className="underline underline-offset-4">Refund policy →</Link></div>
          </div>
          <dl className="overflow-hidden rounded-xl border border-mist bg-white">
            {[
              ["Each started hour", fmt(P.firstHourCents)],
              ["Return deadline", `${P.nonReturnAfterHours} hours from activation`],
              [`Non-return fee if unreturned`, fmt(P.nonReturnMaxCents)],
            ].map(([k, v]) => <div key={k} className="flex items-baseline justify-between gap-5 border-b border-mist px-6 py-5 last:border-0"><dt className="text-graphite">{k}</dt><dd className="shrink-0 font-display text-2xl font-bold">{v}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs leading-5 text-graphite">Taxes are added at checkout. A temporary payment authorization may apply; only the final rental charge is captured. The non-return fee is separate from rental charges and is never charged twice.</p>
        </div>
      </Section>

      <Section dark className="section-cinematic">
        <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <Eyebrow className="text-lime">Still stuck?</Eyebrow>
            <h2 className="display-md mt-5 max-w-2xl">Tell us what happened and we'll investigate.</h2>
            <p className="mt-4 max-w-xl leading-7 text-white/70">Open a ticket and you'll get a ticket number. We reply by email, and you can check progress above with that number. We don't publish response-time promises we can't yet verify.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <OpenAssistant />
            <Link href="/support/new" className="inline-flex min-h-12 items-center rounded-full bg-lime px-6 font-bold text-ink">Open a ticket →</Link>
            <Link href="/contact" className="inline-flex min-h-12 items-center rounded-full border border-white/40 px-6 font-bold">Contact us</Link>
          </div>
        </div>
      </Section>
      <AssistantChat />
      </>} />
  );
}
