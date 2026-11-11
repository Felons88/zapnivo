import type { Metadata } from "next";
import Link from "next/link";
import { Button, Eyebrow, Notice, PageHero, Section } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { CONTACTS, type ContactEntry } from "@/lib/contacts";
import { EMAIL_SENDERS } from "@/lib/email/senders";

export const metadata: Metadata = {
  title: { absolute: "Scam Awareness & Official Zapnivo Communications" },
  description:
    "How to recognize real Zapnivo emails, texts, and kiosks — and what to do if someone pretends to be us. Official Zapnivo contact addresses, spoofing warnings, and how to report fraud.",
  alternates: { canonical: "https://www.zapnivo.com/scam-awareness" },
  openGraph: {
    type: "website",
    siteName: "Zapnivo",
    title: "Scam Awareness & Official Zapnivo Communications",
    description:
      "Recognize real Zapnivo communications and learn what to do if someone pretends to be us — fake emails, texts, payment requests, employees, and tampered kiosk QR codes.",
    url: "https://www.zapnivo.com/scam-awareness",
  },
};

const DIRECTORY: ContactEntry[] = Object.values(CONTACTS);

const SPOOFING = [
  {
    title: "The From address can lie",
    body: "Anyone can type \"Zapnivo\" or even a @zapnivo.com address into an email's From field. Seeing zapnivo.com there is not proof the message is ours. Check the sender's full address against the official list below, and be suspicious of lookalike domains like zapnivo-support.com or zapniv0.com.",
  },
  {
    title: "We never ask for passwords or codes",
    body: "Zapnivo will never ask you for your password, a one-time code, your full card number, or your Social Security number by email, text, or phone. Kiosk payments are handled on the station's own secure screen.",
  },
  {
    title: "Payment requests come from the kiosk",
    body: "Rental payments happen at the station when you scan its QR code and pay on the kiosk screen. We do not send payment links by text or email asking you to \"confirm\" or \"release\" a rental.",
  },
];

const RED_FLAGS = [
  {
    title: "Suspicious emails",
    body: "Urgent warnings about a \"held\" rental, fake refund confirmations, attachments or links to sign-in pages, and requests to \"verify\" your account are common bait. Real Zapnivo emails never ask you to log in through a link to confirm a rental.",
  },
  {
    title: "Suspicious texts (SMS)",
    body: "Texts claiming a missed delivery, a refund waiting, or a charge to reverse — especially with a shortened link — are almost always scams. Zapnivo service texts are sent only about rentals you started at a kiosk.",
  },
  {
    title: "Fake payment requests",
    body: "Anyone claiming to be Zapnivo staff and asking for payment by gift card, wire transfer, cryptocurrency, or a payment app is a scammer. We never collect money that way.",
  },
  {
    title: "Fake employees or partners",
    body: "Be wary of people claiming to represent Zapnivo at events, in parking lots, or by phone — especially anyone asking to check your phone, scan your bank, or pay a \"fee\" to release a rental. Verify venue partnerships through partners@zapnivo.com.",
  },
  {
    title: "Tampered kiosk QR codes",
    body: "Before scanning a QR code on a Zapnivo station, check that the sticker looks official and undamaged, and that the code hasn't been covered by another sticker. Scammers sometimes place their own QR stickers over ours to send you to a fake payment page. When in doubt, don't scan — tell station staff or report it.",
  },
];

const STEPS = [
  { n: "01", title: "Stop and don't click", body: "Don't open links, download attachments, or reply to the suspicious message. If you already did, don't enter any passwords or payment details." },
  { n: "02", title: "Report it to us", body: "Tell us what happened through the scam report form — include the sender address or link if you can copy it safely (don't click it)." },
  { n: "03", title: "Report it to the FTC", body: "File a report with the Federal Trade Commission at reportfraud.ftc.gov so regulators can track the scam. If money was taken, also contact your bank or card issuer right away." },
  { n: "04", title: "Protect your accounts", body: "Change any passwords you may have shared, watch for unexpected charges, and contact support@zapnivo.com if a Zapnivo rental or payment looks wrong." },
];

export default function ScamAwareness() {
  return (
    <>
      <PageHero eyebrow="Scam awareness" title={<>Stay Safe. Know When It&apos;s Really Zapnivo.</>}>
        <p>
          Scammers impersonate brands every day — including ours. This page lists the only official Zapnivo
          email addresses, explains how to spot fake messages and tampered kiosks, and tells you exactly what
          to do if you&apos;ve been targeted.
        </p>
      </PageHero>

      <Section id="official-communications">
        <Eyebrow className="text-forest">Official Zapnivo communications</Eyebrow>
        <h2 className="display-lg mt-5 max-w-3xl">The only addresses that are really us.</h2>
        <p className="lead mt-5 max-w-2xl text-graphite">
          These are Zapnivo&apos;s verified contact addresses, drawn from the same registry our outgoing email
          system uses. Every address below is both a verified outbound sender and a monitored mailbox — our team
          reads replies.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DIRECTORY.map((c, i) => (
            <Reveal key={c.email} delay={i * 60} className="flex min-h-48 flex-col rounded-xl bg-white p-6">
              <span className="eyebrow text-forest">{c.label}</span>
              <a href={`mailto:${c.email}`} className="mt-3 font-display text-xl font-bold text-ink underline decoration-lime decoration-4 underline-offset-4">
                {c.email}
              </a>
              <p className="mt-3 text-sm leading-6 text-graphite">{c.description}</p>
              <p className="mt-auto pt-4 text-xs font-bold uppercase tracking-wider text-forest">
                Verified sender · monitored inbox
              </p>
            </Reveal>
          ))}
          <Reveal delay={DIRECTORY.length * 60} className="flex min-h-48 flex-col rounded-xl border border-mist bg-mist/50 p-6">
            <span className="eyebrow text-graphite">Automated mail</span>
            <p className="mt-3 font-display text-xl font-bold">{EMAIL_SENDERS.noreply.email}</p>
            <p className="mt-3 text-sm leading-6 text-graphite">
              Some automated messages (receipts, notifications) are sent from noreply@zapnivo.com. It&apos;s a
              verified sender, but it&apos;s not a monitored inbox — don&apos;t expect a reply there.
            </p>
            <p className="mt-auto pt-4 text-xs font-bold uppercase tracking-wider text-graphite">Outbound only</p>
          </Reveal>
        </div>
        <p className="mt-6 max-w-3xl text-sm text-graphite">
          Any other address that looks like Zapnivo — including subdomains, misspellings, or free email
          accounts claiming to be staff — is not official. When in doubt, email{" "}
          <a className="font-bold underline underline-offset-4" href={`mailto:${CONTACTS.general.email}`}>{CONTACTS.general.email}</a>{" "}
          and ask.
        </p>
      </Section>

      <Section dark>
        <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
          <div>
            <Eyebrow className="text-lime">Spoofing warning</Eyebrow>
            <h2 className="display-md mt-5">A @zapnivo.com address in the From field is not proof.</h2>
            <p className="mt-5 leading-7 text-white/70">
              Email sender names and addresses are easy to fake. Treat every unexpected message claiming to be
              Zapnivo as suspicious until you&apos;ve verified it against the official list above.
            </p>
          </div>
          <div className="grid gap-4">
            {SPOOFING.map((s) => (
              <div key={s.title} className="rounded-xl bg-white/5 p-6 ring-1 ring-white/10">
                <h3 className="font-display text-xl font-bold">{s.title}</h3>
                <p className="mt-3 text-sm leading-7 text-white/70">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section>
        <Eyebrow className="text-forest">Red flags</Eyebrow>
        <h2 className="display-lg mt-5 max-w-3xl">If it smells like this, it&apos;s not us.</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {RED_FLAGS.map((r, i) => (
            <Reveal key={r.title} delay={i * 60} className="rounded-xl bg-white p-7">
              <h3 className="font-display text-xl font-bold">{r.title}</h3>
              <p className="mt-3 text-sm leading-7 text-graphite">{r.body}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section className="bg-mist">
        <div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]">
          <div>
            <Eyebrow className="text-forest">If you&apos;ve been scammed</Eyebrow>
            <h2 className="display-md mt-5">What to do next.</h2>
            <p className="lead mt-5 text-graphite">
              Act quickly — especially if money or account details were involved.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button href="/scam-awareness/report">Report a scam</Button>
              <Button href="https://reportfraud.ftc.gov" variant="ghost" className="border-ink/30">Report to the FTC</Button>
            </div>
          </div>
          <ol className="divide-y divide-mist border-t border-mist">
            {STEPS.map((s) => (
              <li key={s.n} className="grid gap-3 py-6 sm:grid-cols-[3rem_1fr]">
                <span className="font-display text-3xl font-bold text-forest">{s.n}</span>
                <div>
                  <h3 className="font-display text-lg font-bold">{s.title}</h3>
                  <p className="mt-1 text-sm leading-7 text-graphite">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="mt-10">
          <Notice title="Think it might be real?">
            Forward the suspicious message to{" "}
            <a className="font-bold underline underline-offset-4" href={`mailto:${CONTACTS.security.email}`}>{CONTACTS.security.email}</a>{" "}
            or use the{" "}
            <Link href="/scam-awareness/report" className="font-bold underline underline-offset-4">scam report form</Link>.
            Don&apos;t click links or reply — just tell us what you received.
          </Notice>
        </div>
      </Section>
    </>
  );
}
