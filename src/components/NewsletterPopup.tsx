"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isExcludedRoute, NEWSLETTER_CONSENT_TEXT, type NewsletterPopupConfig, type NewsletterSegment } from "@/lib/newsletter/core";

const SEEN_KEY = "zapnivo_newsletter_seen";
const DAY_MS = 24 * 3600_000;

/**
 * Newsletter capture popup (double opt-in). Mounted once in the (site) layout.
 * - Never renders on excluded routes (checkout/auth/account/portal flows).
 * - Frequency cap via localStorage timestamp (default once per 14 days).
 * - Sits below the cookie ConsentBanner (z-60 vs z-70) and never replaces it.
 * - Business audience still captures email (segment=business → partner lead in
 *   the staff queue) and links out to the full partner application.
 */
export function NewsletterPopup({ config }: { config: NewsletterPopupConfig }) {
  const pathname = usePathname();
  const [phase, setPhase] = useState<"hidden" | "form" | "success">("hidden");
  const [audience, setAudience] = useState<Exclude<NewsletterSegment, "both">>("customer");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const excluded = isExcludedRoute(pathname ?? "/", config.excludedRoutes);

  const markSeen = () => {
    try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* private mode */ }
  };
  const capped = () => {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      if (!raw) return false;
      const t = Date.parse(raw);
      return Number.isFinite(t) && Date.now() - t < config.frequencyCapDays * DAY_MS;
    } catch { return false; }
  };

  useEffect(() => {
    if (!config.enabled || excluded) { setPhase("hidden"); return; }
    if (capped()) return;
    timer.current = setTimeout(() => setPhase("form"), config.delaySeconds * 1000);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, excluded, config.delaySeconds, config.frequencyCapDays, pathname]);

  if (!config.enabled || excluded || phase === "hidden") return null;

  const dismiss = () => { markSeen(); setPhase("hidden"); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, segment: audience, consent, source: "website_popup", website }),
      });
      if (res.ok) { markSeen(); setPhase("success"); return; }
      const data = await res.json().catch(() => ({}));
      setError(data?.error ?? "Something went wrong — please try again.");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Zapnivo newsletter"
      className="fixed bottom-3 left-3 z-[60] w-[min(92vw,380px)] overflow-hidden rounded-2xl bg-ink text-white shadow-2xl md:bottom-6 md:left-6"
    >
      {phase === "success" ? (
        <div className="p-6">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-lime">Zapnivo</p>
          <h2 className="mt-2 font-display text-xl font-bold">Check your inbox</h2>
          <p className="mt-2 text-sm leading-relaxed text-white/70">{config.successMessage}</p>
          <button onClick={dismiss} className="mt-4 min-h-11 rounded-full bg-lime px-5 text-sm font-bold text-ink">Done</button>
        </div>
      ) : (
        <>
          {config.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={config.image} alt="" className="h-28 w-full object-cover" />
          ) : null}
          <div className="p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-lime">Zapnivo</p>
                <h2 className="mt-1 font-display text-2xl font-bold leading-tight">{config.headline}</h2>
              </div>
              <button onClick={dismiss} aria-label="Close newsletter popup" className="rounded-full p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-white/70">{config.description}</p>

            <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Who is this for?">
              {(["customer", "business"] as const).map((a) => (
                <button
                  key={a}
                  role="tab"
                  aria-selected={audience === a}
                  onClick={() => setAudience(a)}
                  className={`min-h-11 rounded-xl border px-3 text-sm font-bold transition-colors ${
                    audience === a ? "border-lime bg-lime/15 text-lime" : "border-white/15 text-white/70 hover:border-white/30"
                  }`}
                >
                  {a === "customer" ? "For customers" : "For business"}
                </button>
              ))}
            </div>
            {audience === "business" ? (
              <p className="mt-2 text-xs leading-relaxed text-white/60">
                Tell us you&apos;re interested and our partnerships team will follow up — or{" "}
                <Link href={config.businessCtaHref} className="font-bold text-lime underline underline-offset-2">start the full application</Link>.
              </p>
            ) : null}

            <form onSubmit={submit} className="mt-4 space-y-3">
              {/* honeypot — hidden from humans */}
              <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
              <label className="sr-only" htmlFor="nl-email">Email address</label>
              <input
                id="nl-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-12 w-full rounded-xl border border-white/15 bg-white/5 px-4 text-sm text-white placeholder:text-white/40 focus:border-lime focus:outline-none"
              />
              <label className="flex items-start gap-2.5 text-xs leading-relaxed text-white/60">
                <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#d9ff73]" />
                <span>{NEWSLETTER_CONSENT_TEXT}</span>
              </label>
              {error ? <p role="alert" className="text-xs font-semibold text-red-300">{error}</p> : null}
              <button
                type="submit"
                disabled={busy || !consent}
                className="min-h-12 w-full rounded-xl bg-lime text-sm font-extrabold text-ink transition-colors hover:bg-[#e6ffa8] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Sending…" : audience === "business" ? config.ctaBusiness : config.ctaCustomer}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
