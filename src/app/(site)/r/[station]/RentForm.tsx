"use client";
import { useRef, useState } from "react";
import { btnClass } from "@/components/ui";
import { inputCls } from "@/components/forms";

export function RentForm({ stationId }: { stationId: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const errRef = useRef<HTMLParagraphElement>(null);

  const fail = (m: string) => { setErr(m); setSending(false); queueMicrotask(() => errRef.current?.focus()); };

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("website")) return;
    setSending(true); setErr(null);
    let res: Response;
    try {
      res = await fetch("/api/rentals/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ station_id: stationId, email: String(f.get("email") ?? "").trim(), bank_count: Number(f.get("bank_count")), promo_code: String(f.get("promo_code") ?? "").trim() || undefined }),
      });
    } catch { return fail("We couldn't reach the server. Check your connection and try again."); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 201 && typeof data.checkout_url === "string") { window.location.href = data.checkout_url; return; }
    if (res.status === 503) return fail("Rentals aren't open yet. Nothing has been charged. Please check back soon.");
    if (res.status === 409) return fail("This station can't take a rental right now. Please try another Zapnivo station.");
    if (res.status === 422) return fail(data.error ?? "Please check your email, number of power banks and promo code.");
    if (res.status === 429) return fail("Too many attempts. Please wait a few minutes and try again.");
    return fail("Something went wrong. Nothing has been charged. Please try again.");
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate={false}>
      <div className="hidden" aria-hidden><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <div><label htmlFor="email" className="mb-1.5 block text-sm font-bold">Email for your receipt</label><input id="email" name="email" type="email" required autoComplete="email" className={inputCls} /></div>
      <div>
        <label htmlFor="bank_count" className="mb-1.5 block text-sm font-bold">Number of power banks</label>
        <select id="bank_count" name="bank_count" defaultValue="1" className={inputCls}><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
      </div>
      <div><label htmlFor="promo_code" className="mb-1.5 block text-sm font-bold">Promo code (optional)</label><input id="promo_code" name="promo_code" maxLength={40} autoComplete="off" className={inputCls} /></div>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="sms_consent" className="mt-1 h-5 w-5" />
        <span className="text-graphite">Text me rental status updates and deadline reminders at the phone I enter at checkout <span className="text-xs">(optional — msg &amp; data rates may apply, reply STOP to opt out)</span></span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="consent" required className="mt-1 h-5 w-5" />
        <span>I agree to the <a className="underline" href="/legal/rental-terms" target="_blank" rel="noopener">rental terms</a> and have read the <a className="underline" href="/legal/privacy" target="_blank" rel="noopener">privacy policy</a>.</span>
      </label>
      <p ref={errRef} tabIndex={-1} role="alert" aria-live="assertive" className="text-sm font-semibold text-red-700 empty:hidden">{err}</p>
      <button type="submit" disabled={sending} className={btnClass("dark", "w-full")}>{sending ? "Starting checkout..." : "Continue to payment"}</button>
    </form>
  );
}
