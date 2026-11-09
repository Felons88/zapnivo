import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { ContactForm } from "@/components/forms";
import { Reveal } from "@/components/Reveal";
import { MarketingHero } from "@/components/MarketingHero";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact Zapnivo for venue partnerships, customer support, advertising and general inquiries.",
};

const ROUTES = [
  { t: "Venue partnerships", d: "Own or manage a space? Start with a partnership application.", href: "/business/apply", cta: "Apply" },
  { t: "Customer support", d: "Rental, return or billing issue? A ticket gets it to the right queue.", href: "/support/new", cta: "Create ticket" },
  { t: "Advertising", d: "Interested in kiosk screen placements? See what's possible.", href: "/advertise", cta: "Explore" },
];

export default function Contact() {
  return (
    <>
      <MarketingHero eyebrow="Contact Zapnivo" title={<>Start the right conversation.</>} description="Questions about rentals, partnerships, or advertising? Choose the route that fits, or send a general message below." actions={<><Button href="#contact-options">Explore contact options</Button><Button href="#general-message" variant="ghost" className="border-white/40 text-white">Send a message</Button></>} />
      <Section id="contact-options">
        <Eyebrow className="text-forest">Choose your route</Eyebrow><h2 className="display-lg mt-5">How can we help?</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {ROUTES.map((r, i) => <Reveal key={r.t} className="flex min-h-64 flex-col rounded-xl bg-white p-7"><span className="font-display text-5xl font-bold text-forest/25">0{i + 1}</span><h3 className="mt-auto font-display text-2xl font-bold">{r.t}</h3><p className="mt-3 text-sm leading-6 text-graphite">{r.d}</p><a href={r.href} className="mt-5 text-sm font-bold underline underline-offset-4">{r.cta} →</a></Reveal>)}
        </div>
      </Section>
      <Section id="general-message" className="bg-mist"><div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]">
          <div><Eyebrow className="text-forest">General message</Eyebrow><h2 className="display-md mt-5">Still need to reach us?</h2><p className="lead mt-5 text-graphite">Choose a topic and tell us what's on your mind. The form sends your note to the appropriate Zapnivo queue.</p></div>
          <div className="rounded-xl bg-white p-6 md:p-10">
            <ContactForm />
          </div>
        </div></Section>
    </>
  );
}
