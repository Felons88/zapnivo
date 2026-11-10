"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { CONSENT_KEY } from "@/lib/analytics";

const post = (body: Record<string, unknown>) => {
  void fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined);
};

const route = () => typeof window === "undefined" ? "" : window.location.pathname;

/** Captures uncaught errors/rejections (always — operational, not tracking) and Core Web Vitals (consent-gated). */
export function Telemetry() {
  const pathname = usePathname();

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const err = e.error instanceof Error ? e.error : new Error(e.message || "Unknown error");
      post({ type: "error", name: err.name || "Error", message: err.message, stack: err.stack, route: route(), user_agent: navigator.userAgent });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason ?? "Unhandled rejection"));
      post({ type: "error", name: err.name || "UnhandledRejection", message: err.message, stack: err.stack, route: route(), user_agent: navigator.userAgent });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); };
  }, []);

  // Core Web Vitals — only with analytics consent.
  useEffect(() => {
    if (localStorage.getItem(CONSENT_KEY) !== "granted" || typeof PerformanceObserver === "undefined") return;
    const send = (name: string, value: number) => post({ type: "vital", name, value, route: pathname, device: deviceClass(), browser: browserName() });
    const deviceClass = () => (window.innerWidth < 768 ? "mobile" : window.innerWidth < 1024 ? "tablet" : "desktop");
    const browserName = () => {
      const ua = navigator.userAgent;
      return /Edg\//.test(ua) ? "edge" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : /Firefox\//.test(ua) ? "firefox" : "other";
    };
    try {
      new PerformanceObserver((list) => {
        const e = list.getEntries().at(-1) as { startTime?: number; value?: number; processingStart?: number; processingEnd?: number } | undefined;
        if (e?.startTime != null) send("TTFB", e.startTime);
        if (e?.processingEnd != null) send("FCP", e.processingEnd);
      }).observe({ type: "paint", buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) send("LCP", (e as { startTime: number }).startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((list) => {
        let cls = 0;
        for (const e of list.getEntries()) cls += (e as { value?: number }).value ?? 0;
        send("CLS", cls);
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* observers unsupported */ }
  }, [pathname]);

  return null;
}
