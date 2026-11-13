"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Item = { type: string; id: string; title: string; subtitle: string | null; href: string; at: string | null };
type Group = { type: string; label: string; items: Item[] };
type Result = { q: string; groups: Group[]; truncated: boolean };

const BADGE_TONE: Record<string, string> = {
  device: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  command: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  exception: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  change: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  incident: "bg-red-500/15 text-red-300 ring-red-400/30",
  agent: "bg-fuchsia-400/15 text-fuchsia-300 ring-fuchsia-400/30",
  error: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  trace: "bg-teal-400/15 text-teal-300 ring-teal-400/30",
  integration: "bg-lime/15 text-lime ring-lime/30",
  migration: "bg-white/10 text-slate-300 ring-white/15",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : null;

export function SearchClient() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (debounced.length < 2) { setResult(null); setError(null); setLoading(false); return; }
    const my = ++seq.current;
    setLoading(true);
    const ctrl = new AbortController();
    fetch(`/api/system/search?q=${encodeURIComponent(debounced)}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Result>;
      })
      .then((r) => { if (my === seq.current) { setResult(r); setError(null); } })
      .catch((e) => { if (my === seq.current && e?.name !== "AbortError") setError("search failed"); })
      .finally(() => { if (my === seq.current) setLoading(false); });
    return () => ctrl.abort();
  }, [debounced]);

  const total = result?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="relative max-w-xl">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search devices, commands, incidents, flags…"
          autoFocus
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-lime/40 focus:outline-none"
        />
        {loading && <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-500">searching…</span>}
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}

      {debounced.length >= 2 && !loading && result && total === 0 && (
        <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-5 py-8 text-sm text-slate-400">
          No results for <span className="font-mono text-slate-200">"{result.q}"</span> in any entity
          your role can view. Try a device uid, command name, incident number, or migration file.
        </p>
      )}

      {result && result.groups.map((g) => (
        <section key={g.type} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">{g.label} <span className="font-mono text-[10px] text-slate-500">({g.items.length})</span></h2>
          <ul className="mt-3 divide-y divide-white/5">
            {g.items.map((it) => (
              <li key={`${it.type}:${it.id}`} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${BADGE_TONE[it.type] ?? BADGE_TONE.migration}`}>{it.type}</span>
                <Link href={it.href} className="font-mono text-xs font-bold text-slate-100 hover:text-lime">{it.title}</Link>
                {it.subtitle && <span className="font-mono text-[11px] text-slate-500">{it.subtitle}</span>}
                <span className="ml-auto font-mono text-[10px] text-slate-500">{fmt(it.at) ?? ""}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {result?.truncated && (
        <p className="text-xs text-slate-500">Some groups hit the per-entity limit — refine the query for complete results.</p>
      )}
    </div>
  );
}
