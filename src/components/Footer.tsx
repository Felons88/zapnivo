import Link from "next/link";
import { FOOTER, SITE } from "@/lib/site";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { Logo } from "./Logo";
import { Button } from "./ui";

export async function Footer() {
  // CMS-overridable footer contact fields (apex/footer) — missing keys hide the line.
  const cms = await getPublishedContent("apex", "footer");
  const contactEmail = cmsText(cms, "contact_email", "");
  const contactPhone = cmsText(cms, "contact_phone", "");
  const mailingAddress = cmsText(cms, "mailing_address", "");
  const groups = Object.entries(FOOTER).map(([group, links]) =>
    group === "Contact Zapnivo" && contactEmail !== ""
      ? [group, links.map((l, i) => (i === 0 ? { ...l, href: `mailto:${contactEmail}`, label: contactEmail } : l))] as const
      : [group, links] as const,
  );
  return (
    <footer className="on-dark bg-ink text-white">
      <div className="section-cinematic border-b border-white/10"><div className="container-z flex flex-col gap-7 py-14 lg:flex-row lg:items-end lg:justify-between"><div><span className="eyebrow text-cyan">Vending solutions for Minnesota</span><h2 className="display-md mt-4 max-w-2xl">Ready when your space is.</h2></div><div className="flex flex-wrap gap-3"><Button href="/get-a-vending-machine">Request a machine</Button><Button href="/locations" variant="ghost" className="border-white/40 text-white">Find a charger</Button></div></div></div>
      <div className="container-z grid-12 py-16 md:py-24">
        <div className="col-span-full lg:col-span-4">
          <Logo />
          <p className="mt-4 max-w-xs text-silver">{SITE.tagline}</p>
          <p className="mt-6 max-w-xs text-sm text-silver">Snacks, drinks, food, phone charging, trading cards, and specialty vending — plus portable charger rentals. Serving Minnesota businesses; placement and availability depend on location and equipment.</p>
          {contactPhone !== "" && <p className="mt-4 max-w-xs text-sm text-silver"><a href={`tel:${contactPhone.replace(/[^+\d]/g, "")}`} className="link-underline text-white/90">{contactPhone}</a></p>}
          {mailingAddress !== "" && <p className="mt-2 max-w-xs whitespace-pre-line text-sm text-silver">{mailingAddress}</p>}
        </div>
        {groups.map(([group, links]) => (
          <nav key={group} aria-label={group} className="col-span-2 mt-8 lg:col-span-2 lg:mt-0">
            <h2 className="eyebrow text-silver">{group}</h2>
            <ul className="mt-4 space-y-3">
              {links.map((l) => <li key={l.href}><Link href={l.href} className="link-underline text-sm text-white/90">{l.label}</Link></li>)}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="container-z flex flex-col gap-2 py-6 text-xs text-silver md:flex-row md:justify-between">
          <span>© {new Date().getFullYear()} Zapnivo Vending Services. All rights reserved.</span>
          <span>Kiosk photography shows actual Zapnivo hardware. Other renders are labeled illustrative.</span>
        </div>
      </div>
    </footer>
  );
}
