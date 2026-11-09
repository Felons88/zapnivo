"use client";
import { useMemo, useState } from "react";
import { inputCls } from "./forms";

export type FaqItem = { q: string; a: string; group: string };

export function Faq({ items }: { items: FaqItem[] }) {
  const [q, setQ] = useState("");
  const [activeGroup, setActiveGroup] = useState("All");
  const allGroups = useMemo(() => ["All", ...new Set(items.map((i) => i.group))], [items]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => (activeGroup === "All" || i.group === activeGroup) && (!needle || `${i.q} ${i.a} ${i.group}`.toLowerCase().includes(needle)));
  }, [items, q, activeGroup]);
  const groups = useMemo(() => [...new Set(filtered.map((i) => i.group))], [filtered]);
  return (
    <div>
      <label htmlFor="faq-search" className="sr-only">Search help articles</label>
      <input id="faq-search" value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search help (e.g. return, billing, refund)" className={`${inputCls} max-w-xl`} />
      <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter help topics">{allGroups.map((group) => <button key={group} type="button" aria-pressed={activeGroup === group} onClick={() => setActiveGroup(group)} className={`min-h-10 rounded-full px-4 text-sm font-bold transition-colors ${activeGroup === group ? "bg-forest text-white" : "bg-white text-ink hover:bg-mist"}`}>{group}</button>)}</div>
      {filtered.length === 0 ? (
        <p className="mt-8 text-graphite">No results for “{q}”. Try a different term or <a className="underline" href="/support/new">create a ticket</a>.</p>
      ) : groups.map((g) => (
        <div key={g} className="mt-10">
          <h2 className="eyebrow text-forest">{g}</h2>
          <div className="mt-3 divide-y divide-mist rounded-lg bg-white">
            {filtered.filter((i) => i.group === g).map((i) => (
              <details key={i.q} className="group px-5 py-4">
                <summary className="cursor-pointer list-none py-1 text-base font-bold marker:hidden">
                  <span className="mr-3 inline-flex h-6 w-6 items-center justify-center rounded-full bg-mist text-xs transition-transform group-open:rotate-45" aria-hidden>+</span>
                  {i.q}
                </summary>
                <p className="pl-9 pt-2 text-graphite">{i.a}</p>
              </details>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
