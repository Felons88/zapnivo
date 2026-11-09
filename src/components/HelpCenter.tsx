"use client";
import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ARTICLES, CATEGORIES, searchArticles, type Article, type Audience } from "@/lib/support-content";
import { inputCls } from "./forms";
import { Eyebrow } from "./ui";

const AUDIENCES: { id: Audience; label: string; hint: string }[] = [
  { id: "renter", label: "I'm renting a charger", hint: "Rentals, returns, billing and refunds" },
  { id: "venue", label: "I'm a venue partner", hint: "Hosting, service, guests and payouts" },
];
const POPULAR: Record<Audience, string[]> = {
  renter: ["refund", "not returned", "didn't dispense", "price", "damaged"],
  venue: ["terms", "guest problem", "service", "placement", "portal"],
};

function ArticleCard({ a, open, onToggle }: { a: Article; open: boolean; onToggle: () => void }) {
  const ticket = a.audience === "renter" ? `/support/new?category=${encodeURIComponent(a.ticket ?? "Other")}` : "/contact?topic=partnerships";
  return (
    <div className="border-b border-mist last:border-0">
      <h3>
        <button type="button" aria-expanded={open} aria-controls={`art-${a.id}`} onClick={onToggle} className="flex w-full items-start justify-between gap-4 px-5 py-5 text-left">
          <span><span className="eyebrow block text-forest/60">{a.category}</span><span className="mt-1 block font-display text-lg font-bold md:text-xl">{a.title}</span></span>
          <span className={`mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lime text-xl transition-transform ${open ? "rotate-45" : ""}`} aria-hidden>+</span>
        </button>
      </h3>
      <div id={`art-${a.id}`} hidden={!open} className="px-5 pb-6">
        <div className="max-w-2xl space-y-3 leading-7 text-graphite">{a.body.map((p, i) => <p key={i}>{p}</p>)}</div>
        <div className="mt-5 flex flex-wrap gap-4 text-sm font-bold">
          {a.audience === "renter" && <a href="#find-rental" className="underline underline-offset-4">Find my rental →</a>}
          <Link href={ticket} className="underline underline-offset-4">{a.audience === "renter" ? "Still need help? Open a ticket →" : "Talk to the partnerships team →"}</Link>
        </div>
      </div>
    </div>
  );
}

/** Zendesk-style help center: audience switch, instant search, category browse. `before` renders between hero and articles, `after` below the articles. */
export function HelpCenter({ initialAudience = "renter", before, after }: { initialAudience?: Audience; before?: ReactNode; after?: ReactNode }) {
  const [audience, setAudience] = useState<Audience>(initialAudience);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const browse = useRef<HTMLDivElement>(null);

  const pool = useMemo(() => ARTICLES.filter((a) => a.audience === audience), [audience]);
  const results = useMemo(() => searchArticles(q, pool), [q, pool]);
  const searching = q.trim().length > 0;
  const shown = searching ? results : cat ? pool.filter((a) => a.category === cat) : pool.filter((a) => a.popular);

  const pickAudience = (a: Audience) => { setAudience(a); setCat(null); setOpenId(null); };
  const pickCat = (name: string) => { setCat(cat === name ? null : name); setQ(""); setOpenId(null); setTimeout(() => browse.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); };

  return (
    <>
      <header className="ambient-hero relative overflow-hidden pb-20 pt-36 text-white md:pb-28 md:pt-44">
        <div className="home-hero-grid absolute inset-0 opacity-70" aria-hidden />
        <div className="absolute -left-32 top-1/3 h-64 w-64 rounded-full border border-cyan/20" aria-hidden />
        <div className="absolute -right-20 -top-20 h-80 w-80 rounded-full border border-pink/20" aria-hidden />
        <div className="container-z relative mx-auto max-w-4xl text-center">
          <Eyebrow className="justify-center text-lime">Zapnivo help center</Eyebrow>
          <h1 className="display-lg mt-6">How can we help?</h1>
          <div role="tablist" aria-label="Who is asking?" className="mx-auto mt-9 inline-flex rounded-full bg-white/10 p-1.5">
            {AUDIENCES.map((a) => (
              <button key={a.id} type="button" role="tab" aria-selected={audience === a.id} onClick={() => pickAudience(a.id)} className={`min-h-11 rounded-full px-5 text-sm font-bold transition-colors ${audience === a.id ? "bg-lime text-ink" : "text-white/80 hover:text-white"}`}>{a.label}</button>
            ))}
          </div>
          <p className="mt-3 text-sm text-white/60">{AUDIENCES.find((a) => a.id === audience)!.hint}</p>
          <div className="relative mx-auto mt-6 max-w-2xl">
            <label htmlFor="help-search" className="sr-only">Search help articles</label>
            <svg className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-forest" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input id="help-search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOpenId(null); }} placeholder={audience === "renter" ? "Search: refund, return, price…" : "Search: terms, service, guests…"} className={`${inputCls} !min-h-16 !rounded-full !border-0 pl-14 pr-6 text-lg shadow-2xl`} />
          </div>
          <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Popular searches">
            <span className="py-2 text-xs font-extrabold uppercase tracking-widest text-white/50">Popular</span>
            {POPULAR[audience].map((t) => <button key={t} type="button" onClick={() => { setQ(t); browse.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="min-h-9 rounded-full border border-white/25 px-4 text-sm font-semibold text-white/85 hover:border-lime hover:text-lime">{t}</button>)}
          </div>
        </div>
      </header>

      {before}

      <section ref={browse} id="answers" className="scroll-mt-28 py-20 md:py-28" aria-label="Help articles">
        <div className="container-z">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <Eyebrow className="text-forest">{audience === "renter" ? "For renters" : "For venue partners"}</Eyebrow>
              <h2 className="display-lg mt-5">{searching ? `Results for “${q.trim()}”` : cat ?? "Browse by topic"}</h2>
            </div>
            {(cat || searching) && <button type="button" onClick={() => { setCat(null); setQ(""); }} className="self-start text-sm font-bold underline underline-offset-4 md:self-auto">Clear · show all topics</button>}
          </div>

          {!searching && !cat && (
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CATEGORIES[audience].map((c, i) => (
                <button key={c.name} type="button" onClick={() => pickCat(c.name)} className="home-step group flex min-h-48 flex-col rounded-xl border border-mist bg-white p-6 text-left">
                  <span className="font-display text-4xl font-bold text-forest/25">0{i + 1}</span>
                  <span className="mt-auto font-display text-xl font-bold">{c.name}</span>
                  <span className="mt-1 text-sm text-graphite">{c.blurb}</span>
                  <span className="mt-3 text-xs font-extrabold uppercase tracking-widest text-forest">{pool.filter((a) => a.category === c.name).length} articles <span className="inline-block transition-transform group-hover:translate-x-1" aria-hidden>→</span></span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-10 overflow-hidden rounded-xl bg-white" aria-live="polite">
            {!searching && !cat && <p className="border-b border-mist bg-mist/60 px-5 py-3 text-xs font-extrabold uppercase tracking-widest text-forest">Popular articles</p>}
            {shown.length === 0 ? (
              <div className="p-8 text-center">
                <p className="font-display text-2xl font-bold">No articles match that.</p>
                <p className="mx-auto mt-2 max-w-md text-graphite">Try a different word, or ask us directly. Include your rental reference if you have one.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-3"><button type="button" onClick={() => window.dispatchEvent(new Event("zapnivo:open-assistant"))} className="inline-flex min-h-12 items-center rounded-full bg-forest px-6 font-bold text-white">Ask the AI assistant</button><Link href={audience === "renter" ? "/support/new" : "/contact?topic=partnerships"} className="inline-flex min-h-12 items-center rounded-full bg-lime px-6 font-bold">{audience === "renter" ? "Open a support ticket" : "Contact partnerships"} →</Link></div>
              </div>
            ) : shown.map((a) => <ArticleCard key={a.id} a={a} open={openId === a.id} onToggle={() => setOpenId(openId === a.id ? null : a.id)} />)}
          </div>
        </div>
      </section>

      {after}
    </>
  );
}
