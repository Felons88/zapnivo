"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";

const PAGES = [
  { href: "/", title: "Home", detail: "Portable power and Zapnivo overview", terms: "home charger power bank" },
  { href: "/how-it-works", title: "How rentals work", detail: "Scan, rent, charge, and return", terms: "rent rental pricing return bank" },
  { href: "/locations", title: "Find a station", detail: "Verified live station map", terms: "locations map station near me" },
  { href: "/business", title: "For venues", detail: "Managed charging partnerships", terms: "business host venue hotel restaurant" },
  { href: "/business/apply", title: "Partner application", detail: "Tell us about your venue", terms: "apply application partnership" },
  { href: "/advertise", title: "Advertising", detail: "Explore developing ad opportunities", terms: "advertise ads brand sponsor" },
  { href: "/support", title: "Support", detail: "Rental, return, and billing answers", terms: "help faq refund billing" },
  { href: "/support/new", title: "Create a ticket", detail: "Get help with a rental issue", terms: "ticket issue return refund" },
  { href: "/about", title: "About Zapnivo", detail: "Our mission and rollout", terms: "company mission story" },
  { href: "/contact", title: "Contact", detail: "Send us a message", terms: "contact email inquiry" },
];

export function SiteSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen(true); }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  useEffect(() => {
    if (!open) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(document.querySelectorAll<HTMLElement>("#site-search-dialog input, #site-search-dialog button, #site-search-dialog a"));
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", trap); trigger.current?.focus(); };
  }, [open]);
  const term = query.trim().toLowerCase();
  const results = term ? PAGES.filter(p => `${p.title} ${p.detail} ${p.terms}`.toLowerCase().includes(term)) : PAGES.slice(0, 6);
  return <>
    <button ref={trigger} type="button" onClick={() => { setQuery(""); setOpen(true); }} aria-label="Search site" className="grid h-11 w-11 place-items-center rounded-full border border-current/25 hover:bg-lime hover:text-ink"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg></button>
    {open && createPortal(<div className="fixed inset-0 z-[100] flex items-start justify-center bg-ink/80 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div id="site-search-dialog" role="dialog" aria-modal="true" aria-label="Search Zapnivo" className="w-full max-w-2xl overflow-hidden rounded-[1.5rem] bg-paper text-ink shadow-2xl">
        <div className="flex items-center gap-3 border-b border-mist p-5"><span className="text-xl" aria-hidden>⌕</span><label htmlFor="site-search-input" className="sr-only">Search pages</label><input ref={input} id="site-search-input" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search rentals, locations, support..." className="min-w-0 flex-1 bg-transparent text-lg outline-none" /><button type="button" onClick={() => setOpen(false)} className="rounded-md border border-mist px-2 py-1 text-xs font-bold">Esc</button></div>
        <div className="max-h-[60vh] overflow-y-auto p-3"><p className="px-3 py-2 text-xs font-extrabold uppercase tracking-widest text-graphite">{term ? "Search results" : "Popular pages"}</p>{results.length ? results.map(page => <Link key={page.href} href={page.href} onClick={() => setOpen(false)} className="flex items-center justify-between rounded-lg px-4 py-3 hover:bg-lime/30"><span><strong className="block font-display text-lg">{page.title}</strong><span className="block text-sm text-graphite">{page.detail}</span></span><span aria-hidden>→</span></Link>) : <p className="p-5 text-graphite">No pages match that search. Try a different term or visit support.</p>}</div>
      </div>
    </div>, document.body)}
  </>;
}
