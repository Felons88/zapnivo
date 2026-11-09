import type { ReactNode } from "react";
import { Eyebrow } from "./ui";

export function MarketingHero({ eyebrow, title, description, actions, visual, note, tone = "forest" }: {
  eyebrow: string; title: ReactNode; description: string; actions?: ReactNode; visual?: ReactNode; note?: ReactNode; tone?: "forest" | "lime";
}) {
  const dark = tone === "forest";
  return <header className={`relative overflow-hidden pt-36 pb-16 md:pt-44 md:pb-24 ${dark ? "ambient-hero text-white" : "section-neon text-ink"}`}>
    <div className="home-hero-grid absolute inset-0 opacity-70" aria-hidden />
    <div className="absolute -left-32 top-1/3 h-64 w-64 rounded-full border border-cyan/20" aria-hidden />
    <div className="absolute -right-20 -top-20 h-80 w-80 rounded-full border border-pink/20" aria-hidden />
    <div className="container-z relative grid items-center gap-10 lg:grid-cols-[1.1fr_.9fr]">
      <div>
        <Eyebrow className={dark ? "text-lime" : "text-forest"}>{eyebrow}</Eyebrow>
        <h1 className="display-lg mt-6 max-w-4xl">{title}</h1>
        <p className={`lead mt-6 max-w-2xl ${dark ? "text-white/75" : "text-graphite"}`}>{description}</p>
        {actions && <div className="mt-8 flex flex-wrap gap-3">{actions}</div>}
      </div>
      <div className={`ambient-visual relative flex min-h-72 items-center justify-center overflow-hidden rounded-[2rem] p-6 sm:min-h-96 ${dark ? "" : "bg-forest"}`}>
        <div className="absolute h-64 w-64 rounded-full bg-lime/20 blur-[70px]" aria-hidden />
        <div className="hero-orbit absolute h-3/4 w-3/4 rounded-full" aria-hidden />
        {visual ?? <span className="font-display text-[clamp(7rem,20vw,17rem)] font-bold leading-none text-lime" aria-hidden>↗</span>}
        {note && <div className="absolute bottom-4 left-4 right-4 rounded-lg bg-ink/85 px-4 py-3 text-xs font-bold text-white">{note}</div>}
      </div>
    </div>
  </header>;
}
