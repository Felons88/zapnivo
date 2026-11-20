"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type PaletteItem = { group: string; label: string; href: string };

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 9);
    return items.filter((i) => `${i.group} ${i.label}`.toLowerCase().includes(t)).slice(0, 9);
  }, [q, items]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQ("");
      router.push(href);
    },
    [router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (!typing && e.key === "/") {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setCursor(0);
      // Focus after paint so the overlay exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const total = results.length + 1; // results + "search records" row
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, total - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor < results.length) go(results[cursor].href);
      else if (q.trim().length >= 2) go(`/admin/search?q=${encodeURIComponent(q.trim())}`);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="fixed inset-0 z-[100] flex items-start justify-center bg-[#0a2540]/40 px-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[#e3e8ee] bg-white shadow-[0_25px_60px_rgba(10,37,64,.25)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-[#e3e8ee] px-4">
          <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4 shrink-0 text-[#8898aa]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0); }}
            onKeyDown={onInputKey}
            placeholder="Jump to a tool or search records…"
            aria-label="Jump to a tool or search records"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[#0a2540] outline-none placeholder:text-[#8898aa]"
          />
          <kbd className="hidden shrink-0 rounded border border-[#e3e8ee] bg-[#f6f9fc] px-1.5 py-0.5 text-[10px] font-semibold text-[#8898aa] sm:block">esc</kbd>
        </div>
        <ul ref={listRef} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.map((item, i) => (
            <li key={item.href} data-i={i}>
              <button
                role="option"
                aria-selected={cursor === i}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(item.href)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${cursor === i ? "bg-[#edeeff]" : ""}`}
              >
                <span className="min-w-0 flex-1 font-medium text-[#0a2540]">{item.label}</span>
                <span className="shrink-0 text-[11px] font-medium text-[#8898aa]">{item.group}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="px-3 py-3 text-xs text-[#8898aa]">No tool matches.</li> : null}
          <li data-i={results.length}>
            <button
              role="option"
              aria-selected={cursor === results.length}
              disabled={q.trim().length < 2}
              onMouseEnter={() => setCursor(results.length)}
              onClick={() => q.trim().length >= 2 && go(`/admin/search?q=${encodeURIComponent(q.trim())}`)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm disabled:opacity-40 ${cursor === results.length ? "bg-[#edeeff]" : ""}`}
            >
              <span className="min-w-0 flex-1 font-medium text-[#635bff]">
                {q.trim().length >= 2 ? `Search records for “${q.trim()}”` : "Type 2+ characters to search records"}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-[#8898aa]">Records</span>
            </button>
          </li>
        </ul>
        <p className="border-t border-[#e3e8ee] px-4 py-2 text-[11px] text-[#8898aa]">
          ↑↓ navigate · ↵ open · ⌘K or / to summon
        </p>
      </div>
    </div>
  );
}
