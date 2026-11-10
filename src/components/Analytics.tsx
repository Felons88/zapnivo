"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { CONSENT_KEY, type PublicEventName } from "@/lib/analytics";

const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    __zapSession?: string;
  }
}

function sessionRef(): string {
  if (typeof window === "undefined") return "";
  let s = window.__zapSession;
  if (!s) {
    s = sessionStorage.getItem("zap_session") ?? crypto.randomUUID();
    sessionStorage.setItem("zap_session", s);
    window.__zapSession = s;
  }
  return s;
}

/** Fire a first-party business event. No-ops without analytics consent; strips query/fragment. */
export function trackEvent(name: PublicEventName, props?: Record<string, string | number | boolean>) {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(CONSENT_KEY) !== "granted") return;
  const path = window.location.pathname;
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, props: { ...(props ?? {}), path }, session_ref: sessionRef(), consent_state: "granted" }),
    keepalive: true,
  }).catch(() => undefined);
  window.gtag?.("event", name, { page_path: path, ...props });
}

/** Mount once in the site layout. Handles consent, GA4 loading, session + page-view events, SPA navigation. */
export function Analytics() {
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const consent = () => localStorage.getItem(CONSENT_KEY);
    if (consent() !== "granted") return;

    // GA4: load gtag only after consent, once.
    if (GA_ID && !document.getElementById("ga-gtag")) {
      window.dataLayer = window.dataLayer ?? [];
      window.gtag = function (...args: unknown[]) { window.dataLayer!.push(args); };
      const s = document.createElement("script");
      s.id = "ga-gtag";
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
      document.head.appendChild(s);
      window.gtag("js", new Date());
      window.gtag("config", GA_ID, { send_page_view: false, anonymize_ip: true });
    }

    // Legacy sink: existing track() calls forward into GA4.
    (window as unknown as { __zapnivoAnalytics?: (e: string, p?: object) => void }).__zapnivoAnalytics = (event: string, props?: object) => {
      window.gtag?.("event", event, props);
    };

    if (!started.current) {
      started.current = true;
      trackEvent("session_start");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Page views on mount + every client-side navigation (deduped).
  useEffect(() => {
    if (localStorage.getItem(CONSENT_KEY) !== "granted") return;
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    trackEvent("page_view");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
}
