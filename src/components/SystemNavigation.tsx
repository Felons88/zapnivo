"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavGroup } from "./SystemShell";

function NavContents({ groups, close }: { groups: NavGroup[]; close?: () => void }) {
  const path = usePathname() ?? "/system";
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const current = useMemo(() => groups.flatMap((group) => group.items)
    .filter((item) => item.href && (path === item.href || path.startsWith(`${item.href}/`)))
    .sort((a, b) => (b.href?.length ?? 0) - (a.href?.length ?? 0))[0]?.href, [groups, path]);
  const activeGroup = groups.find((group) => group.items.some((item) => item.href === current))?.name;
  const [expanded, setExpanded] = useState<string[]>(() => activeGroup ? [activeGroup] : [groups[0]?.name ?? ""]);

  useEffect(() => {
    if (activeGroup) setExpanded((open) => open.includes(activeGroup) ? open : [...open, activeGroup]);
  }, [activeGroup]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !["INPUT", "TEXTAREA"].includes(target?.tagName ?? "")) {
        event.preventDefault(); input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const filtered = query.trim()
    ? groups.map((group) => ({ ...group, items: group.items.filter((item) => `${group.name} ${item.label}`.toLowerCase().includes(query.toLowerCase())) })).filter((group) => group.items.length)
    : groups;
  const quick = groups.flatMap((group) => group.items).filter((item): item is { href: string; label: string } => !!item.href).slice(0, 4);
  const toggle = (name: string) => setExpanded((open) => open.includes(name) ? open.filter((item) => item !== name) : [...open, name]);

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="px-4 pb-4 pt-5">
      <label htmlFor={close ? "system-nav-filter-mobile" : "system-nav-filter"} className="mb-2 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Find a tool</label>
      <div className="relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 5 5"/></svg>
        <input ref={input} id={close ? "system-nav-filter-mobile" : "system-nav-filter"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search navigation" className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.06] pl-10 pr-10 text-sm text-white outline-none placeholder:text-slate-500 focus:border-lime/60" />
        <kbd className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-500 xl:block">/</kbd>
      </div>
    </div>
    {!query && <div className="border-y border-white/[0.07] px-4 py-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Quick access</p>
      <div className="grid grid-cols-2 gap-1.5">{quick.map((item) => <Link key={item.href} href={item.href} onClick={close} aria-current={current === item.href ? "page" : undefined} className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${current === item.href ? "bg-lime text-ink" : "bg-white/[0.05] text-slate-300 hover:bg-white/10 hover:text-white"}`}>{item.label}</Link>)}</div>
    </div>}
    <nav aria-label="System console" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-4">
      {filtered.map((group) => {
        const open = !!query || expanded.includes(group.name);
        return <div key={group.name} className="rounded-xl">
          <button type="button" onClick={() => toggle(group.name)} aria-expanded={open} className={`flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-left text-[11px] font-bold uppercase tracking-[0.11em] transition-colors ${group.name === activeGroup ? "text-lime" : "text-slate-400 hover:bg-white/[0.06] hover:text-white"}`}>
            <span>{group.name}</span><svg viewBox="0 0 20 20" aria-hidden className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m5 7.5 5 5 5-5"/></svg>
          </button>
          {open && <div className="mb-2 space-y-0.5 border-l border-white/10 pl-2 ml-3">
            {group.items.map((item) => item.href
              ? <Link key={`${group.name}-${item.label}`} href={item.href} onClick={close} aria-current={current === item.href ? "page" : undefined} className={`flex min-h-9 items-center rounded-lg px-3 text-[13px] transition-colors ${current === item.href ? "bg-lime/[0.13] font-bold text-lime shadow-[inset_2px_0_0_#d9ff73]" : "text-slate-300 hover:bg-white/[0.06] hover:text-white"}`}>{item.label}</Link>
              : <span key={`${group.name}-${item.label}`} className="flex min-h-9 items-center justify-between px-3 text-[13px] text-slate-600">{item.label}<span className="text-[10px] uppercase">Soon</span></span>)}
          </div>}
        </div>;
      })}
      {filtered.length === 0 && <p className="px-3 py-5 text-sm text-slate-400">No tools match “{query}”.</p>}
    </nav>
  </div>;
}

export function SystemDesktopNavigation({ groups }: { groups: NavGroup[] }) {
  return <NavContents groups={groups} />;
}

export function SystemMobileNavigation({ groups }: { groups: NavGroup[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return <div className="lg:hidden">
    <button type="button" onClick={() => setOpen(true)} aria-label="Open system navigation" aria-expanded={open} className="grid size-10 place-items-center rounded-xl border border-white/10 text-slate-200">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="size-5"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    {open && <div className="fixed inset-0 z-50 h-dvh">
      <button type="button" aria-label="Close navigation" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/75" />
      <div className="absolute inset-y-0 left-0 flex w-[min(88vw,340px)] flex-col border-r border-white/10 bg-[#101923] shadow-2xl">
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-5"><span className="text-xs font-bold uppercase tracking-[0.2em] text-lime">System navigation</span><button type="button" aria-label="Close navigation" onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-lg text-xl text-slate-300 hover:bg-white/10">×</button></div>
        <NavContents groups={groups} close={() => setOpen(false)} />
      </div>
    </div>}
  </div>;
}

export function SystemPageContext({ groups }: { groups: NavGroup[] }) {
  const path = usePathname() ?? "/system";
  const matches = groups.flatMap((group) => group.items.map((item) => ({ group: group.name, item })))
    .filter(({ item }) => item.href && (path === item.href || path.startsWith(`${item.href}/`)))
    .sort((a, b) => (b.item.href?.length ?? 0) - (a.item.href?.length ?? 0));
  const current = matches[0];
  return <div className="flex min-w-0 items-center gap-2 text-xs">
    <span className="text-slate-500">{current?.group ?? "System"}</span>
    <span className="text-slate-600">/</span>
    <span className="truncate font-semibold text-slate-200">{current?.item.label ?? "Overview"}</span>
  </div>;
}
