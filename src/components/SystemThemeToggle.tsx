"use client";

import { useState } from "react";

export type SystemTheme = "dark" | "light";
const COOKIE = "zapnivo_system_theme";

export function SystemThemeToggle({ initialTheme }: { initialTheme: SystemTheme }) {
  const [theme, setTheme] = useState(initialTheme);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.querySelector(".system-console")?.setAttribute("data-theme", next);
    document.cookie = `${COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  return <button type="button" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} className="grid size-9 place-items-center rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] text-[var(--sys-text)] transition hover:border-[var(--sys-accent)]">
    {theme === "dark"
      ? <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></svg>
      : <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M20.5 14.2A8.7 8.7 0 0 1 9.8 3.5 8.8 8.8 0 1 0 20.5 14.2Z" /></svg>}
  </button>;
}
