"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV } from "@/lib/site";
import { VENDING_CATEGORIES } from "@/lib/vending";
import { Logo } from "./Logo";
import { btnClass } from "./ui";
import { SiteSearch } from "./SiteSearch";

type Announcement = { text: string; href?: string } | null;

/**
 * Pure announcement selection (unit tested): auth paths suppress the strip;
 * /support/* (the internal path support.zapnivo.com rewrites to) prefers the
 * support site's banner; everything else uses the apex banner.
 */
export function pickAnnouncement(path: string, apex: Announcement, support: Announcement): { show: boolean; announcement: Announcement } {
  if (path === "/login" || path.startsWith("/login/")) return { show: false, announcement: null };
  const onSupport = path === "/support" || path.startsWith("/support/");
  return { show: true, announcement: onSupport && support?.text ? support : apex };
}

type MenuId = "vending" | "business" | "company" | "charging";
type MenuLink = { href: string; label: string; copy: string };
type Menu = { eyebrow: string; title: string; copy: string; links: MenuLink[] };

const MENUS: Record<MenuId, Menu> = {
  vending: {
    eyebrow: "Vending solutions",
    title: "Machines for every kind of space.",
    copy: "From snacks and beverages to phone charging and trading cards — one Minnesota provider for your whole placement.",
    links: VENDING_CATEGORIES.map((c) => ({ href: c.href, label: c.label, copy: c.description })),
  },
  business: {
    eyebrow: "For businesses",
    title: "Put a machine to work for you.",
    copy: "Tell us about your space and we'll talk through placement, equipment, and service.",
    links: [
      { href: "/get-a-vending-machine", label: "Request a Machine", copy: "Tell us what you need and where." },
      { href: "/business/apply", label: "Become a Venue Partner", copy: "Apply to host Zapnivo equipment." },
      { href: "/business", label: "How Placement Works", copy: "What happens from inquiry to install." },
      { href: "/vending/locations", label: "Service Areas", copy: "Where we place machines today." },
    ],
  },
  company: {
    eyebrow: "Our company",
    title: "Get to know Zapnivo.",
    copy: "A Minnesota-based vending service provider building machines, placements, and support around local businesses.",
    links: [
      { href: "/about", label: "About", copy: "Who we are and what we do." },
      { href: "/contact", label: "Contact", copy: "Reach the team directly." },
      { href: "/support", label: "FAQs", copy: "Answers to common questions." },
    ],
  },
  charging: {
    eyebrow: "Customer charging",
    title: "Power on the move.",
    copy: "Zapnivo also runs portable charger rentals — find a station, rent a power bank, and return it when you're done.",
    links: [
      { href: "/locations", label: "Find a Charger", copy: "Verified live rental stations." },
      { href: "/how-it-works", label: "How Charging Works", copy: "Scan, charge, and return." },
      { href: "/support", label: "Charging Support", copy: "Returns, billing, and help." },
    ],
  },
};

const MENU_BUTTONS: [MenuId, string][] = [
  ["vending", "Vending Solutions"],
  ["business", "For Businesses"],
  ["company", "Our Company"],
  ["charging", "Customer Charging"],
];

export function Header({ heroDark = false, announcement, supportAnnouncement }: { heroDark?: boolean; announcement?: { text: string; href?: string } | null; supportAnnouncement?: { text: string; href?: string } | null }) {
  const path = usePathname();
  const picked = pickAnnouncement(path, announcement ?? null, supportAnnouncement ?? null);
  const active = picked.announcement;
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const solid = scrolled || open || menu !== null;
  // Pages whose top section is light need the light header variant even though the layout defaults to dark-hero.
  const lightTop = path.startsWith("/support/articles") || path.startsWith("/support/ticket");
  const onDark = heroDark && !solid && !lightTop && !path.startsWith("/admin") && !path.startsWith("/partners");
  const data = menu ? MENUS[menu] : null;

  useEffect(() => {
    const on = () => {
      setScrolled(window.scrollY > 24);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar.current) bar.current.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => { setOpen(false); setMenu(null); }, [path]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setMenu(null); } };
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-lime focus:px-5 focus:py-3 focus:font-bold">Skip to content</a>
      <header onMouseLeave={() => setMenu(null)} className={`fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow,color] duration-300 ${solid ? "bg-paper/95 text-ink shadow-[0_1px_0_#e8ebe6] backdrop-blur-md" : onDark ? "text-white" : "text-ink"}`}>
        {picked.show ? (
        <div className="section-neon py-2 text-center text-[10px] font-extrabold uppercase tracking-[.13em] text-ink sm:text-xs">
          {active?.text ? (
            <>{active.text}{active.href ? <> · <Link href={active.href} className="ml-2 underline underline-offset-2">Learn more →</Link></> : null}</>
          ) : (
            <>Vending solutions for Minnesota businesses · Now accepting machine placement inquiries <Link href="/get-a-vending-machine" className="ml-2 underline underline-offset-2">Request a machine →</Link></>
          )}
        </div>
        ) : null}
        <div className="container-z flex h-[72px] items-center justify-between">
          <Link href="/" aria-label="Zapnivo home" className="relative z-[60]"><Logo className={open ? "text-white" : ""} /></Link>
          <nav aria-label="Primary" className="hidden items-center gap-5 xl:flex">
            {MENU_BUTTONS.map(([id, label]) => <button key={id} type="button" aria-expanded={menu === id} aria-controls="desktop-mega-menu" onMouseEnter={() => setMenu(id)} onClick={() => setMenu(menu === id ? null : id)} className="link-underline flex items-center gap-1 py-2 text-sm font-semibold">{label}<span className={`text-xs transition-transform ${menu === id ? "rotate-180" : ""}`} aria-hidden>⌄</span></button>)}
            <Link href="/get-a-vending-machine" className={btnClass("primary", "min-h-11 px-5 text-sm")}>Request a Machine</Link>
            <Link href="/locations" className={btnClass(onDark && !solid ? "ghost" : "ghost", "min-h-11 border-current/40 px-5 text-sm")}>Find a Charger</Link>
          </nav>
          <div className="ml-auto mr-2 lg:ml-0 lg:mr-0"><SiteSearch /></div>
          <button type="button" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)} className={`relative z-[60] flex h-12 w-12 items-center justify-center rounded-full lg:hidden ${open ? "text-white" : ""}`}>
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
            <span aria-hidden className="relative block h-3 w-6">
              <span className={`absolute left-0 h-0.5 w-6 bg-current transition-all duration-300 ${open ? "top-1.5 rotate-45" : "top-0"}`} />
              <span className={`absolute left-0 h-0.5 w-6 bg-current transition-all duration-300 ${open ? "top-1.5 -rotate-45" : "top-3"}`} />
            </span>
          </button>
        </div>
        {data && menu && <div id="desktop-mega-menu" className="hidden border-t border-mist bg-paper text-ink shadow-[0_25px_45px_-25px_rgba(0,0,0,.3)] lg:block" onKeyDown={e => { if (e.key === "Escape") setMenu(null); }}>
          <div className="container-z grid gap-8 py-8 lg:grid-cols-[.8fr_1.2fr]">
            <div className="rounded-xl bg-forest p-7 text-white"><span className="eyebrow text-lime">{data.eyebrow}</span><h2 className="mt-4 font-display text-3xl font-bold">{data.title}</h2><p className="mt-3 max-w-md text-sm leading-6 text-white/70">{data.copy}</p></div>
            <div className={`grid gap-3 ${menu === "vending" ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}>{data.links.map(item => <Link key={item.href} href={item.href} onClick={() => setMenu(null)} className="group flex items-start justify-between rounded-lg border border-mist bg-white p-5 hover:border-forest hover:bg-lime/15"><span><strong className="block font-display text-lg">{item.label}</strong><span className="mt-1 block text-sm text-graphite">{item.copy}</span></span><span className="transition-transform group-hover:translate-x-1" aria-hidden>→</span></Link>)}</div>
          </div>
        </div>}
        <div ref={bar} aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] origin-left scale-x-0 bg-lime" />
      </header>
      <div id="mobile-menu" data-open={open} aria-hidden={!open} className="mobile-menu on-dark fixed inset-0 z-[55] flex flex-col justify-between bg-ink px-6 pb-10 pt-28 text-white lg:hidden">
        <nav aria-label="Mobile" className="flex flex-col">
          {NAV.map((n, i) => (
            <Link key={n.href} href={n.href} tabIndex={open ? 0 : -1} style={{ transitionDelay: open ? `${150 + i * 60}ms` : "0ms" }} className={`border-b border-white/10 py-4 font-display text-4xl font-bold tracking-tight transition-all duration-500 ${open ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}>{n.label}</Link>
          ))}
        </nav>
        <div className="flex flex-col gap-3">
          <Link href="/get-a-vending-machine" tabIndex={open ? 0 : -1} className={btnClass("primary", "w-full text-lg")}>Request a Machine</Link>
          <Link href="/locations" tabIndex={open ? 0 : -1} className={btnClass("ghost", "w-full border-white/40 text-white")}>Find a Charger</Link>
        </div>
      </div>
    </>
  );
}
