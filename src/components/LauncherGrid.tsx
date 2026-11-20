"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type LauncherTile = {
  id: string;
  name: string;
  blurb: string;
  href: string;
  shortcut: string;
  /** Tile accent — Lovable tone color (oklch) used by the glyph + hover ring. */
  color: string;
  icon: ReactNode;
  sections: { label: string; href: string }[];
  badge?: number;
};

const KEY = "zapnivo.launcher.v1";
type Prefs = { fav: string[]; recent: string[] };
const DEFAULTS: Prefs = { fav: ["overview", "support", "kiosks"], recent: [] };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const Star = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 2.5 2.9 5.9 6.6 1-4.7 4.6 1.1 6.5L12 17.4l-5.9 3.1 1.1-6.5L2.5 9.4l6.6-1Z" />
  </svg>
);

export function LauncherGrid({ tiles }: { tiles: LauncherTile[] }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);

  useEffect(() => setPrefs(load()), []);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs]);

  const toggleFav = useCallback((id: string) => {
    setPrefs((s) => ({ ...s, fav: s.fav.includes(id) ? s.fav.filter((f) => f !== id) : [...s.fav, id] }));
  }, []);
  const touchRecent = useCallback((id: string) => {
    setPrefs((s) => (s.recent[0] === id ? s : { ...s, recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, 5) }));
  }, []);

  /* Single-key module shortcuts (Lovable launcher UX) — o/v/k/r/p/s/u/n/m/a/f/y.
     Suppressed while typing, with modifiers, or when the palette is open. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const tile = tiles.find((x) => x.shortcut === e.key.toLowerCase());
      if (tile) {
        e.preventDefault();
        touchRecent(tile.id);
        router.push(tile.href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tiles, router, touchRecent]);

  const pinned = prefs.fav.map((id) => tiles.find((t) => t.id === id)).filter((t): t is LauncherTile => !!t);
  const recent = prefs.recent.map((id) => tiles.find((t) => t.id === id)).filter((t): t is LauncherTile => !!t);

  return (
    <div>
      {(pinned.length > 0 || recent.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {pinned.length > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8898aa]">
              Pinned
              {pinned.map((t) => (
                <Link key={t.id} href={t.href} onClick={() => touchRecent(t.id)} className="rounded-full border border-[#e3e8ee] bg-white px-2.5 py-1 text-[11px] font-semibold normal-case tracking-normal text-[#0a2540] transition hover:border-[#635bff] hover:text-[#635bff]">
                  {t.name}
                </Link>
              ))}
            </span>
          )}
          {recent.length > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#8898aa]">
              Recent
              {recent.map((t) => (
                <Link key={t.id} href={t.href} onClick={() => touchRecent(t.id)} className="rounded-full bg-white/60 px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-[#425466] transition hover:bg-white hover:text-[#635bff]">
                  {t.name}
                </Link>
              ))}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t, i) => {
          const fav = prefs.fav.includes(t.id);
          return (
            <div
              key={t.id}
              className="anim-rise group relative flex flex-col rounded-xl border border-[#e3e8ee] bg-white p-4 shadow-[0_1px_2px_rgba(10,37,64,.04),0_4px_16px_-6px_rgba(10,37,64,.08)] transition hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(10,37,64,.05),0_18px_40px_-14px_rgba(10,37,64,.22)]"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <Link href={t.href} onClick={() => touchRecent(t.id)} className="block">
                <span className="flex items-start justify-between">
                  <span className="tile-glyph grid h-10 w-10 place-items-center rounded-xl" style={{ color: t.color }}>
                    <span className="text-white [&_svg]:h-5 [&_svg]:w-5">{t.icon}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {t.badge ? <span className="rounded-full bg-[#ffe2e5] px-2 py-0.5 text-[11px] font-semibold text-[#df1b41]">{t.badge}</span> : null}
                    <kbd className="hidden rounded border border-[#e3e8ee] bg-[#f6f9fc] px-1.5 py-0.5 text-[10px] font-semibold text-[#8898aa] sm:block">{t.shortcut}</kbd>
                  </span>
                </span>
                <span className="mt-3 block text-sm font-semibold tracking-tight text-[#0a2540]">{t.name}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[#8898aa]">{t.blurb}</span>
              </Link>
              {t.sections.length > 0 && (
                <span className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-[#eef1f5] pt-2.5">
                  {t.sections.slice(0, 4).map((s) => (
                    <Link key={s.label} href={s.href} onClick={() => touchRecent(t.id)} className="text-[11px] font-medium text-[#425466] transition hover:text-[#635bff]">
                      {s.label}
                    </Link>
                  ))}
                </span>
              )}
              <button
                type="button"
                aria-label={fav ? `Unpin ${t.name}` : `Pin ${t.name}`}
                aria-pressed={fav}
                onClick={() => toggleFav(t.id)}
                className={`absolute bottom-3 right-3 rounded-md p-1 transition ${fav ? "text-[#f0a63c]" : "text-[#c3ccd8] opacity-0 hover:text-[#8898aa] focus-visible:opacity-100 group-hover:opacity-100"}`}
              >
                <Star filled={fav} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
