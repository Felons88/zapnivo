"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function TestModeButton({ deviceId, enabled }: { deviceId: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/test-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError((body as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      router.refresh();
    } catch {
      setError("Could not reach the station service. Try again.");
    } finally { setBusy(false); }
  };

  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${enabled ? "bg-amber-400/15 text-amber-200 ring-amber-400/40" : "bg-slate-400/10 text-slate-300 ring-slate-400/30"}`}>
        {enabled ? "TEST MODE ON" : "TEST MODE OFF"}
      </span>
      <button type="button" onClick={toggle} disabled={busy}
        className={`rounded-full px-4 py-2 text-xs font-bold disabled:opacity-50 ${enabled ? "bg-slate-400/20 text-white ring-1 ring-slate-400/40" : "bg-lime text-ink"}`}>
        {busy ? "Updating…" : enabled ? "Switch to live" : "Enable test mode"}
      </button>
    </div>
    <p className="text-[11px] text-slate-400">
      {enabled
        ? "Test mode is ON: the app and checkout accept this station before it is online at a published venue with ready banks. Stripe payment still applies — use test keys."
        : "Test mode relaxes live-availability checks for this station only, so you can test the app and checkout before deployment. Payment is unaffected."}
    </p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </div>;
}
