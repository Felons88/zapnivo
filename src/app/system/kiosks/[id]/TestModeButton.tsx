"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Mirrors SIM_SCENARIOS in src/lib/kiosk/dispatch.ts. */
const SCENARIOS: { value: string; label: string }[] = [
  { value: "success", label: "Success — staged ack → release" },
  { value: "offline", label: "Kiosk offline — never picks up" },
  { value: "jam", label: "Slot jam — mid-cycle failure" },
  { value: "timeout", label: "Eject timeout — ack, no confirm" },
  { value: "empty", label: "Empty kiosk — no inventory" },
  { value: "delayed_ack", label: "Delayed ack — slow hardware" },
  { value: "duplicate_ack", label: "Duplicate events — idempotency" },
  { value: "partial", label: "Partial dispense — fewer banks" },
  { value: "lost_ack", label: "Lost ack — unknown outcome" },
];

export function TestModeButton({ deviceId, enabled, scenario }: { deviceId: string; enabled: boolean; scenario?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simScenario, setSimScenario] = useState(scenario ?? "success");

  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/test-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError((json as { error?: string }).error ?? `HTTP ${res.status}`); return; }
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
      <button type="button" onClick={() => post({ enabled: !enabled })} disabled={busy}
        className={`rounded-full px-4 py-2 text-xs font-bold disabled:opacity-50 ${enabled ? "bg-slate-400/20 text-white ring-1 ring-slate-400/40" : "bg-lime text-ink"}`}>
        {busy ? "Updating…" : enabled ? "Switch to live" : "Enable test mode"}
      </button>
    </div>
    {enabled && (
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="sim-scenario" className="text-[11px] font-bold text-slate-300">Simulated dispense scenario</label>
        <select
          id="sim-scenario"
          value={simScenario}
          onChange={(e) => { setSimScenario(e.target.value); post({ enabled: true, scenario: e.target.value }); }}
          disabled={busy}
          className="rounded-lg border border-slate-500/40 bg-slate-900 px-2 py-1 text-[11px] text-white disabled:opacity-50"
        >
          {SCENARIOS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <span className="text-[10px] text-slate-500">Next checkout at this station runs this simulated hardware outcome through the real command pipeline.</span>
      </div>
    )}
    <p className="text-[11px] text-slate-400">
      {enabled
        ? "Test mode is ON: the app and checkout accept this station before it is online at a published venue with ready banks. Dispensing is simulated through the real command pipeline — Stripe payment still applies, use test keys."
        : "Test mode relaxes live-availability checks for this station only, so you can test the app and checkout before deployment. Payment is unaffected."}
    </p>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </div>;
}
