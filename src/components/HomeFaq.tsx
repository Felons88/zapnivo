import Link from "next/link";
import { Eyebrow, Section } from "./ui";

const FAQ = [
  { q: "How do I rent a power bank?", a: "At a participating station, scan its QR code, review the current rental terms, and complete checkout. A power bank is released after payment is confirmed." },
  { q: "Where can I return it?", a: "Return the power bank to an eligible participating Zapnivo station. Your rental shows eligible return locations." },
  { q: "How much does a rental cost?", a: "Pilot pricing is still proposed and may change before launch. The current terms and final rate are shown before you pay at a station." },
  { q: "Can my business host a station?", a: "Yes. Tell us about your venue through the partner application. We review placement and discuss partnership terms privately." },
  { q: "What if I need help with a rental?", a: "Visit Zapnivo support for help with returns, billing, or a station issue." },
];

export function HomeFaq() {
  return <Section className="section-lavender"><div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]"><div><Eyebrow className="text-forest">FAQs</Eyebrow><h2 className="display-lg mt-5">Good questions.<br />Clear answers.</h2><p className="mt-6 text-graphite">Need more detail? <Link href="/support" className="font-bold underline underline-offset-4">Visit the help center</Link>.</p></div><div className="divide-y divide-mist rounded-xl border border-mist bg-white p-4 shadow-xl shadow-violet/10 sm:p-8">{FAQ.map(({ q, a }) => <details key={q} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-6 font-display text-lg font-bold marker:hidden sm:text-xl">{q}<span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lime text-xl transition-transform group-open:rotate-45" aria-hidden>+</span></summary><p className="max-w-2xl pb-2 pr-12 pt-3 leading-7 text-graphite">{a}</p></details>)}</div></div></Section>;
}
