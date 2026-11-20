"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { SystemApp } from "@/lib/system/apps";

const STORAGE_KEY = "zapnivo-system-recent-apps";
const CATEGORIES = ["Business", "Operations", "Platform"] as const;

function AppIcon({ type }: { type: SystemApp["icon"] }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const shapes: Record<SystemApp["icon"], ReactNode> = {
    care: <><path d="M4 5h16v11H8l-4 4V5Z" /><path d="M8 9h8M8 13h5" /></>,
    customers: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M17 5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-5" /></>,
    venue: <><path d="M3 9h18l-2-5H5L3 9ZM5 9v11h14V9M9 20v-6h6v6" /><path d="M3 9c0 3 4 3 5 0 1 3 5 3 6 0 1 3 5 3 7 0" /></>,
    finance: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>,
    analytics: <><path d="M3 20h18M5 17l4-5 4 2 6-8" /><path d="M16 6h3v3" /></>,
    staff: <><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0M4 4h3M17 4h3" /></>,
    fleet: <><rect x="3" y="5" width="18" height="13" rx="2" /><path d="M7 9h4v5H7zM15 9h3M15 13h3M7 21h10" /></>,
    monitor: <><path d="M3 12h4l2-5 4 10 2-5h6" /><path d="M4 4h16v16H4z" /></>,
    deploy: <><path d="M12 3v12m0-12 4 4m-4-4L8 7M4 15v4h16v-4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m12 2 2 2 3-.5.5 3L20 8l-1 3 1 3-2.5 1.5-.5 3-3-.5-2 2-2-2-3 .5-.5-3L4 14l1-3-1-3 2.5-1.5.5-3 3 .5 2-2Z" /></>,
    knowledge: <><path d="M4 4h7a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3 1V4Zm16 0h-3a3 3 0 0 0-3 3v13h3a3 3 0 0 1 3 1V4Z" /></>,
    sites: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01M7 13h5M7 16h10" /></>,
    ai: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M9 11h.01M15 11h.01M9 15h6M12 2v3M12 19v3" /></>,
    security: <><path d="M12 2 20 5v6c0 5-3 8-8 11-5-3-8-6-8-11V5l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  };
  return <svg viewBox="0 0 24 24" className="size-6" aria-hidden {...common}>{shapes[type]}</svg>;
}

export function SystemAppLauncher({ apps }: { apps: SystemApp[] }) {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(saved)) setRecent(saved.filter((id): id is string => typeof id === "string").slice(0, 5));
    } catch { /* Invalid local preference is ignored. */ }
  }, []);
  const remember = (id: string) => {
    const next = [id, ...recent.filter((item) => item !== id)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
  };
  const recentApps = recent.map((id) => apps.find((app) => app.id === id)).filter((app): app is SystemApp => !!app);

  return <div className="space-y-9">
    {recentApps.length > 0 && <section aria-labelledby="recent-apps-title">
      <h2 id="recent-apps-title" className="mb-3 text-sm font-bold text-[var(--sys-text)]">Recently opened</h2>
      <div className="flex flex-wrap gap-2">{recentApps.map((app) => <Link key={app.id} href={app.href} onClick={() => remember(app.id)} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--sys-border)] bg-[var(--sys-surface)] px-4 text-sm font-semibold text-[var(--sys-text)] transition hover:border-[var(--sys-accent)]"><span className="text-[var(--sys-accent)]"><AppIcon type={app.icon} /></span>{app.name}</Link>)}</div>
    </section>}
    {CATEGORIES.map((category) => {
      const entries = apps.filter((app) => app.category === category);
      if (!entries.length) return null;
      return <section key={category} aria-labelledby={"apps-" + category.toLowerCase()}>
        <div className="mb-4 flex items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.15em] text-[var(--sys-muted)]">{category}</p><h2 id={"apps-" + category.toLowerCase()} className="mt-1 text-xl font-bold tracking-tight text-[var(--sys-text)]">{category === "Business" ? "Run the business" : category === "Operations" ? "Operate the network" : "Build and secure the platform"}</h2></div><span className="text-xs text-[var(--sys-muted)]">{entries.length} applications</span></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{entries.map((app) => <Link key={app.id} href={app.href} onClick={() => remember(app.id)} className="group flex min-h-48 flex-col rounded-2xl border border-[var(--sys-border)] bg-[var(--sys-surface)] p-5 text-[var(--sys-text)] shadow-[var(--sys-shadow)] transition duration-150 hover:-translate-y-0.5 hover:border-[var(--sys-accent)] hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sys-accent)]">
          <span className="flex items-start justify-between"><span className="grid size-11 place-items-center rounded-xl bg-[var(--sys-icon-bg)] text-[var(--sys-accent)]"><AppIcon type={app.icon} /></span><span aria-hidden className="text-lg text-[var(--sys-muted)] transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5">↗</span></span>
          <span className="mt-auto pt-6"><span className="block text-base font-bold">{app.name}</span><span className="mt-1.5 block text-sm leading-5 text-[var(--sys-muted)]">{app.description}</span></span>
        </Link>)}</div>
      </section>;
    })}
  </div>;
}
