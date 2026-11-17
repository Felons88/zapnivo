"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Identity = {
  email: string;
  names: string[];
  phones: string[];
  hasAccount: boolean;
  sources: string[];
  rentalCount: number;
  openTickets: number;
};

/**
 * Type-ahead customer lookup — debounced calls to GET /api/admin/customers.
 * Progressive enhancement: the wrapping form still submits ?q= without JS.
 */
export function CustomerSearchBox({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<Identity[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/customers?q=${encodeURIComponent(t)}`);
        if (res.ok) setResults(((await res.json()) as { results: Identity[] }).results ?? []);
      } catch { /* keep whatever we had */ }
      setLoading(false);
      setOpen(true);
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const go = (email: string) => { setOpen(false); router.push(`/admin/customers/${encodeURIComponent(email)}`); };

  return (
    <div ref={box} className="relative flex-1">
      <input
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Jane Smith · (555) 123-4567 · jane@email.com · ZR-…"
        aria-label="Customer search"
        role="combobox"
        aria-expanded={open}
        className="min-h-11 w-full rounded-lg border border-silver/70 px-4 text-sm"
      />
      {open && q.trim().length >= 2 && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-96 overflow-auto rounded-xl border border-mist bg-white shadow-lg">
          {loading && <li className="px-4 py-3 text-xs font-bold text-graphite">Searching…</li>}
          {!loading && results.length === 0 && <li className="px-4 py-3 text-xs text-graphite">No matches — press Search to keep looking.</li>}
          {results.map((c) => (
            <li key={c.email} role="option" aria-selected={false}>
              <button type="button" onClick={() => go(c.email)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-lime/15">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{c.names[0] ?? c.email}</span>
                  <span className="block truncate text-xs text-graphite">{c.email}{c.phones[0] ? ` · ${c.phones[0]}` : ""}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-graphite">
                  {c.hasAccount ? <span className="rounded-full bg-lime px-2 py-0.5 text-ink">account</span> : <span className="rounded-full bg-mist px-2 py-0.5">guest</span>}
                  {c.rentalCount > 0 && <span>{c.rentalCount} rental{c.rentalCount === 1 ? "" : "s"}</span>}
                  {c.openTickets > 0 && <span className="rounded-full bg-gold/60 px-2 py-0.5">{c.openTickets} open</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
