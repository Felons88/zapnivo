"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Scroll-reveal using IntersectionObserver. Content stays visible if JS or the observer is unavailable. */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" | "article" | "p" }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) { el?.classList.add("in"); return; }
    if (el.getBoundingClientRect().top < window.innerHeight * 1.05) { el.classList.add("in"); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add("in"); io.disconnect(); } }, { rootMargin: "0px 0px 12% 0px", threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const T = Tag as "div";
  return <T ref={ref as React.RefObject<HTMLDivElement>} data-reveal style={{ "--d": `${delay}ms` } as React.CSSProperties} className={className}>{children}</T>;
}
