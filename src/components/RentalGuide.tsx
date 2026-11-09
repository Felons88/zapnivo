"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { btnClass } from "./ui";

type Choice = "rent" | "host" | "learn";
const RESULTS: Record<Choice, { title: string; copy: string; href: string; cta: string; secondary: string; secondaryHref: string }> = {
  rent: { title: "Your next charge starts at a station.", copy: "See verified live locations and check the current rental terms at the station before checkout.", href: "/locations", cta: "Explore station map", secondary: "How rentals work", secondaryHref: "/how-it-works" },
  host: { title: "Bring portable power to your venue.", copy: "Tell us about your space. We'll discuss placement, servicing, and partnership details with you directly.", href: "/business/apply", cta: "Request a consultation", secondary: "Explore venue partnerships", secondaryHref: "/business" },
  learn: { title: "Start with the rental flow.", copy: "See how a power bank is rented, carried, and returned, plus the proposed pilot pricing status.", href: "/how-it-works", cta: "See how it works", secondary: "Visit support", secondaryHref: "/support" },
};

export function RentalGuide() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (sessionStorage.getItem("zapnivo-guide-seen")) return;
    const timer = window.setTimeout(() => {
      sessionStorage.setItem("zapnivo-guide-seen", "1");
      setOpen(true);
    }, 7000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const focusable = Array.from(document.querySelectorAll<HTMLElement>("#rental-guide-dialog a, #rental-guide-dialog button"));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", onKey); (previous ?? triggerRef.current)?.focus(); };
  }, [open]);

  return <>
    <section className="section-neon py-20 md:py-28" aria-labelledby="guide-title">
      <div className="container-z grid gap-10 lg:grid-cols-[1.25fr_.75fr] lg:items-center">
        <div><p className="eyebrow">Find your next step</p><h2 id="guide-title" className="display-lg mt-5 max-w-3xl">Need a charge? Have a space?</h2><p className="lead mt-5 max-w-2xl text-graphite">Whether you're looking for portable power or want to host a station, we'll point you to the right place.</p></div>
        <div className="rounded-xl bg-ink p-7 text-white shadow-xl md:p-9"><span className="eyebrow text-lime">Quick guide</span><h3 className="mt-4 font-display text-3xl font-bold">What brings you here?</h3><p className="mt-3 text-white/70">Choose one answer and get a clear next step.</p><button ref={triggerRef} type="button" onClick={() => { setChoice(null); setOpen(true); }} className={btnClass("primary", "mt-7 w-full")}>Open the guide <span aria-hidden>↗</span></button></div>
      </div>
    </section>
    {open && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/75 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div id="rental-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-dialog-title" className="relative w-full max-w-2xl rounded-[2rem] bg-paper p-6 shadow-2xl sm:p-10">
        <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close guide" className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full bg-mist text-xl font-bold hover:bg-lime">×</button>
        <span className="eyebrow text-forest">Zapnivo quick guide</span>
        {!choice ? <><h2 id="guide-dialog-title" className="display-md mt-4 pr-12">What brings you here?</h2><p className="mt-3 text-graphite">Pick the option that fits. You can always explore the rest of the site afterward.</p><div className="mt-7 grid gap-3">
          {([["rent", "I need a power bank", "Find a station and learn how to rent."], ["host", "I have a venue", "Explore a managed charging partnership."], ["learn", "I'm just exploring", "See the rental process and common questions."]] as const).map(([value, title, copy]) => <button type="button" key={value} onClick={() => setChoice(value)} className="group flex min-h-20 items-center justify-between rounded-lg border border-mist bg-white p-4 text-left hover:border-forest hover:bg-lime/20"><span><strong className="block font-display text-lg">{title}</strong><span className="mt-1 block text-sm text-graphite">{copy}</span></span><span className="ml-4 text-2xl" aria-hidden>→</span></button>)}
        </div></> : <><h2 id="guide-dialog-title" className="display-md mt-4 pr-12">{RESULTS[choice].title}</h2><p className="lead mt-4 text-graphite">{RESULTS[choice].copy}</p><div className="mt-8 flex flex-wrap gap-3"><Link href={RESULTS[choice].href} onClick={() => setOpen(false)} className={btnClass("dark")}>{RESULTS[choice].cta} <span aria-hidden>→</span></Link><Link href={RESULTS[choice].secondaryHref} onClick={() => setOpen(false)} className={btnClass("ghost", "border-ink/30")}>{RESULTS[choice].secondary}</Link></div><button type="button" onClick={() => setChoice(null)} className="mt-7 text-sm font-bold underline underline-offset-4">Choose another option</button></>}
      </div>
    </div>}
  </>;
}
