import Link from "next/link";
import { Eyebrow, Section } from "./ui";

const FAQ = [
  { q: "How can my business request a vending machine?", a: "Complete the short placement inquiry with your business details, address, venue type, expected traffic and the categories you are interested in. Our team reviews it and follows up directly." },
  { q: "What kinds of machines does Zapnivo offer?", a: "We work across snacks, beverages, food, portable phone charging, trading cards and collectibles, and specialty concepts. Portable charging is our most developed line today; the other categories are evaluated and sourced per placement." },
  { q: "What types of locations are suitable?", a: "Workplaces, hotels, retail properties, apartment communities, entertainment venues, manufacturing sites, restaurants and bars, and fitness or recreation facilities. Steady foot traffic, a safe power source and clear access matter most." },
  { q: "Does requesting a machine cost anything?", a: "Submitting an inquiry has no charge. Any commercial terms are discussed for a specific proposed placement and agreed before an installation decision." },
  { q: "How are placement and servicing handled?", a: "If a placement moves forward, we coordinate equipment, installation and a service plan with you. Responsibilities for stocking, maintenance and support are confirmed in writing for each location." },
  { q: "Which parts of Minnesota can you serve?", a: "Minnesota is our home market and we welcome inquiries from across the state. Availability depends on the address, the category requested and equipment on hand, so we confirm coverage when we review your location." },
  { q: "Can I ask for a specific type of machine?", a: "Yes. Choose a product interest on the form or describe what you have in mind. We will tell you honestly whether it is something we can source for your space." },
  { q: "What happens after I submit an inquiry?", a: "You receive a confirmation email, and our team reviews the location details. We then get in touch to talk through options. An inquiry is a conversation starter and does not guarantee placement." },
];

export function HomeFaq() {
  const faqLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };
  return <Section className="section-lavender"><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} /><div className="grid gap-10 lg:grid-cols-[.7fr_1.3fr]"><div><Eyebrow className="text-forest">FAQs</Eyebrow><h2 className="display-lg mt-5">Questions from<br />business owners.</h2><p className="mt-6 text-graphite">Renting a power bank? <Link href="/support" className="font-bold underline underline-offset-4">Visit charging support</Link>.</p></div><div className="divide-y divide-mist rounded-xl border border-mist bg-white p-4 shadow-xl shadow-violet/10 sm:p-8">{FAQ.map(({ q, a }) => <details key={q} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-6 font-display text-lg font-bold marker:hidden sm:text-xl">{q}<span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lime text-xl transition-transform group-open:rotate-45" aria-hidden>+</span></summary><p className="max-w-2xl pb-2 pr-12 pt-3 leading-7 text-graphite">{a}</p></details>)}</div></div></Section>;
}
