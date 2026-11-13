"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NAV } from "@/lib/site";
import { Logo } from "./Logo";
import { btnClass } from "./ui";
import { SiteSearch } from "./SiteSearch";

export function Header({ heroDark = false, announcement }: { heroDark?: boolean; announcement?: { text: string; href?: string } | null }) {
  const path = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<"rent" | "venues" | "explore" | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const solid = scrolled || open || menu !== null;
  // Pages whose top section is light need the light header variant even though the layout defaults to dark-hero.
  const lightTop = path.startsWith("/support/articles") || path.startsWith("/support/ticket");
  const onDark = heroDark && !solid && !lightTop && !path.startsWith("/admin") && !path.startsWith("/partners");

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
        <div className="section-neon py-2 text-center text-[10px] font-extrabold uppercase tracking-[.13em] text-ink sm:text-xs">
          {announcement?.text ? (
            <>{announcement.text}{announcement.href ? <> · <Link href={announcement.href} className="ml-2 underline underline-offset-2">Learn more →</Link></> : null}</>
          ) : (
            <>Portable charger rentals · Rolling out across Minnesota <Link href="/locations" className="ml-2 underline underline-offset-2">View locations →</Link></>
          )}
        </div>
        <div className="container-z flex h-[72px] items-center justify-between">
          <Link href="/" aria-label="Zapnivo home" className="relative z-[60]"><Logo className={open ? "text-white" : ""} /></Link>
          <nav aria-label="Primary" className="hidden items-center gap-7 lg:flex">
            {([["rent", "Rent a charger"], ["venues", "For venues"], ["explore", "Explore"]] as const).map(([id, label]) => <button key={id} type="button" aria-expanded={menu === id} aria-controls="desktop-mega-menu" onMouseEnter={() => setMenu(id)} onClick={() => setMenu(menu === id ? null : id)} className="link-underline flex items-center gap-1 py-2 text-sm font-semibold">{label}<span className={`text-xs transition-transform ${menu === id ? "rotate-180" : ""}`} aria-hidden>⌄</span></button>)}
            <Link href="/locations" className="link-underline py-2 text-sm font-semibold">Locations</Link>
            <Link href="/support" className="link-underline py-2 text-sm font-semibold">Support</Link>
            <Link href="/business/apply" className={btnClass(onDark && !solid ? "primary" : "dark", "min-h-11 px-5 text-sm")}>Partner With Us</Link>
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
        {menu && <div id="desktop-mega-menu" className="hidden border-t border-mist bg-paper text-ink shadow-[0_25px_45px_-25px_rgba(0,0,0,.3)] lg:block" onKeyDown={e => { if (e.key === "Escape") setMenu(null); }}>
          <div className="container-z grid gap-8 py-8 lg:grid-cols-[.8fr_1.2fr]">
            <div className="rounded-xl bg-forest p-7 text-white"><span className="eyebrow text-lime">{menu === "rent" ? "Portable power" : menu === "venues" ? "Venue partnerships" : "Discover Zapnivo"}</span><h2 className="mt-4 font-display text-3xl font-bold">{menu === "rent" ? "Charge wherever the day goes." : menu === "venues" ? "A better guest amenity." : "Get to know the network."}</h2><p className="mt-3 max-w-md text-sm leading-6 text-white/70">{menu === "rent" ? "Find a verified station, understand the rental flow, and get help when you need it." : menu === "venues" ? "Explore placement, managed service, and how to start a conversation with our team." : "Learn about the company, advertising opportunities, and support."}</p></div>
            <div className="grid gap-3 sm:grid-cols-2">{(menu === "rent" ? [
              { href: "/how-it-works", label: "How rentals work", copy: "Scan, charge, and return." },
              { href: "/locations", label: "Find a station", copy: "Verified live locations." },
              { href: "/support", label: "Rental support", copy: "Returns, billing, and help." },
              { href: "/legal/rental-terms", label: "Rental terms", copy: "Read the current terms." },
            ] : menu === "venues" ? [
              { href: "/business", label: "For businesses", copy: "Explore the venue experience." },
              { href: "/business/apply", label: "Partner application", copy: "Tell us about your space." },
              { href: "/advertise", label: "Advertising", copy: "Explore brand opportunities." },
              { href: "/contact", label: "Contact us", copy: "Start a conversation." },
            ] : [
              { href: "/about", label: "About Zapnivo", copy: "The story behind the network." },
              { href: "/how-it-works", label: "How it works", copy: "A closer look at rentals." },
              { href: "/support", label: "Help center", copy: "Answers to common questions." },
              { href: "/contact", label: "Contact", copy: "Reach the team." },
            ]).map(item => <Link key={item.href} href={item.href} onClick={() => setMenu(null)} className="group flex items-start justify-between rounded-lg border border-mist bg-white p-5 hover:border-forest hover:bg-lime/15"><span><strong className="block font-display text-lg">{item.label}</strong><span className="mt-1 block text-sm text-graphite">{item.copy}</span></span><span className="transition-transform group-hover:translate-x-1" aria-hidden>→</span></Link>)}</div>
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
        <Link href="/business/apply" tabIndex={open ? 0 : -1} className={btnClass("primary", "w-full text-lg")}>Partner With Us</Link>
      </div>
    </>
  );
}
