"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CONSENT_KEY } from "@/lib/analytics";

export function ConsentBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(!localStorage.getItem(CONSENT_KEY)), []);
  if (!show) return null;
  const set = (v: "granted" | "denied") => { localStorage.setItem(CONSENT_KEY, v); setShow(false); };
  return (
    <div role="dialog" aria-label="Privacy preferences" className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-xl rounded-lg bg-ink p-5 text-white shadow-2xl md:left-auto md:right-6 md:bottom-6 md:mx-0">
      <p className="text-sm">We use optional, privacy-conscious analytics to improve the site. Nothing is tracked unless you accept. <Link href="/legal/cookie-policy" className="underline">Cookie Policy</Link></p>
      <div className="mt-4 flex gap-3">
        <button onClick={() => set("granted")} className="min-h-11 rounded-full bg-lime px-5 text-sm font-bold text-ink">Accept analytics</button>
        <button onClick={() => set("denied")} className="min-h-11 rounded-full border border-white/30 px-5 text-sm font-bold">Decline</button>
      </div>
    </div>
  );
}
