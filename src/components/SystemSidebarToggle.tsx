"use client";

import { useEffect, useState } from "react";

const KEY = "zapnivo-system-sidebar";

export function SystemSidebarToggle() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) === "compact";
      setCompact(saved);
      document.querySelector(".system-console")?.setAttribute("data-sidebar", saved ? "compact" : "expanded");
    } catch { /* Storage may be disabled. */ }
  }, []);
  const toggle = () => {
    const next = !compact;
    setCompact(next);
    document.querySelector(".system-console")?.setAttribute("data-sidebar", next ? "compact" : "expanded");
    try { localStorage.setItem(KEY, next ? "compact" : "expanded"); } catch { /* Storage may be disabled. */ }
  };
  return <button type="button" onClick={toggle} aria-label={compact ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={compact} title={compact ? "Expand sidebar" : "Collapse sidebar"} className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--sys-border)] text-[var(--sys-muted)] transition hover:border-[var(--sys-accent)] hover:text-[var(--sys-text)]">
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d={compact ? "m13 9 3 3-3 3" : "m17 9-3 3 3 3"} /></svg>
  </button>;
}
