import Link from "next/link";
import { FOOTER, SITE } from "@/lib/site";
import { getPublishedContent, text as cmsText } from "@/lib/site-content";
import { Logo } from "./Logo";
import { Button } from "./ui";

export async function Footer() {
  // CMS-overridable footer contact email (apex/footer) — falls back to CONTACTS.
  const cms = await getPublishedContent("apex", "footer");
  const contactEmail = cmsText(cms, "contact_email", "");
  const groups = Object.entries(FOOTER).map(([group, links]) =>
    group === "Contact Zapnivo" && contactEmail !== ""
      ? [group, links.map((l, i) => (i === 0 ? { ...l, href: `mailto:${contactEmail}`, label: contactEmail } : l))] as const
      : [group, links] as const,
  );
  return (
    <footer className="on-dark bg-ink text-white">
      <div className="section-cinematic border-b border-white/10"><div className="container-z flex flex-col gap-7 py-14 lg:flex-row lg:items-end lg:justify-between"><div><span className="eyebrow text-cyan">Portable power for real life</span><h2 className="display-md mt-4 max-w-2xl">Ready when the day keeps going.</h2></div><div className="flex flex-wrap gap-3"><Button href="/locations">Find a station</Button><Button href="/business/apply" variant="ghost" className="border-white/40 text-white">Host a station</Button></div></div></div>
      <div className="container-z grid-12 py-16 md:py-24">
        <div className="col-span-full lg:col-span-4">
          <Logo />
          <p className="mt-4 max-w-xs text-silver">{SITE.tagline}</p>
          <p className="mt-6 max-w-xs text-sm text-silver">Rolling out across Minnesota. The map shows only verified live stations.</p>
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
          <span>© {new Date().getFullYear()} Zapnivo. All rights reserved.</span>
          <span>Kiosk photography shows actual Zapnivo hardware. Other renders are labeled illustrative.</span>
        </div>
      </div>
    </footer>
  );
}
