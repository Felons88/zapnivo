import Link from "next/link";
import { FOOTER, SITE } from "@/lib/site";
import { CONTACTS } from "@/lib/contacts";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { Logo } from "./Logo";

export async function Footer() {
  // CMS-overridable footer contact fields (apex/footer) — missing keys hide the line.
  const cms = await getPublishedContent("apex", "footer");
  const contactEmail = cmsText(cms, "contact_email", CONTACTS.general.email);
  const contactPhone = cmsText(cms, "contact_phone", "");
  const mailingAddress = cmsText(cms, "mailing_address", "");
  const groups = Object.entries(FOOTER);
  return (
    <footer className="on-dark bg-ink text-white">
      <div className="container-z grid gap-9 py-16 sm:grid-cols-2 lg:grid-cols-[2fr_repeat(5,minmax(0,1fr))] md:py-24">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo />
          <p className="mt-4 max-w-xs text-silver">{SITE.tagline}</p>
          <p className="mt-6 max-w-xs text-sm text-silver">Snacks, drinks, food, phone charging, trading cards, and specialty vending — plus portable charger rentals. Serving Minnesota businesses; placement and availability depend on location and equipment.</p>
          <p className="mt-4 break-all text-sm"><a href={`mailto:${contactEmail}`} className="link-underline text-white">{contactEmail}</a></p>
          {contactPhone !== "" && <p className="mt-4 max-w-xs text-sm text-silver"><a href={`tel:${contactPhone.replace(/[^+\d]/g, "")}`} className="link-underline text-white/90">{contactPhone}</a></p>}
          {mailingAddress !== "" && <p className="mt-2 max-w-xs whitespace-pre-line text-sm text-silver">{mailingAddress}</p>}
        </div>
        {groups.map(([group, links]) => (
          <nav key={group} aria-label={group}>
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
