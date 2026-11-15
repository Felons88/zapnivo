import type { ReactNode } from "react";
import { Eyebrow } from "./ui";

export function MarketingHero({ eyebrow, title, description, actions, visual, note, tone = "forest" }: {
  eyebrow: string; title: ReactNode; description: string; actions?: ReactNode; visual?: ReactNode; note?: ReactNode; tone?: "forest" | "lime";
}) {
  const dark = tone === "forest";
  return <header className={`relative overflow-hidden pt-36 pb-16 md:pt-44 md:pb-24 ${dark ? "ambient-hero text-white" : "section-neon text-ink"}`}>
    <div className="container-z relative grid items-center gap-10 lg:grid-cols-[1.1fr_.9fr]">
      <div>
        <Eyebrow className={dark ? "text-lime" : "text-forest"}>{eyebrow}</Eyebrow>
        <h1 className="display-lg mt-6 max-w-4xl">{title}</h1>
        <p className={`lead mt-6 max-w-2xl ${dark ? "text-white/75" : "text-graphite"}`}>{description}</p>
        {actions && <div className="mt-8 flex flex-wrap gap-3">{actions}</div>}
      </div>
      <div className={`ambient-visual relative flex min-h-72 items-center justify-center overflow-hidden p-6 sm:min-h-96 ${dark ? "" : "bg-forest"}`}>
        {visual ?? <span className="font-display text-[clamp(7rem,20vw,17rem)] font-bold leading-none text-lime" aria-hidden>↗</span>}
        {note && <div className="absolute bottom-4 left-4 right-4 rounded-lg bg-ink/85 px-4 py-3 text-xs font-bold text-white">{note}</div>}
      </div>
    </div>
  </header>;
}
