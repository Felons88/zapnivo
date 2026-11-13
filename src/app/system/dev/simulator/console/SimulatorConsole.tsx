"use client";
import { useState } from "react";

const SCENARIOS = [
  { id: "heartbeat", label: "Heartbeat + inventory", desc: "Provision a sim kiosk and post heartbeat + slot_state events." },
  { id: "lifecycle", label: "Full rental lifecycle", desc: "Heartbeat → inventory → dispense ack → return detected → dock." },
  { id: "duplicate_replay", label: "Duplicate replay", desc: "Post the same signed batch + nonce twice; second must be rejected." },
  { id: "auth_reject", label: "Forged signature", desc: "Negative test — corrupted HMAC signature must get 401." },
  { id: "certification_suite", label: "Certification suite", desc: "runSimulatedSuite — hash-chained certification ledger run (heavier)." },
] as const;

type Run = { at: string; scenario: string; ok: boolean; body: unknown };

export function SimulatorConsole() {
  const [scenario, setScenario] = useState<string>("heartbeat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/system/dev/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setRuns((rs) => [{ at: new Date().toISOString(), scenario, ok: true, body }, ...rs].slice(0, 10));
    } catch {
      setError("request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <section className="space-y-2 rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="eyebrow text-slate-400">Scenario</h2>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScenario(s.id)}
            className={`block w-full rounded-xl border px-3 py-2.5 text-left transition ${scenario === s.id ? "border-lime/40 bg-lime/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"}`}
          >
            <span className={`block font-mono text-xs font-bold ${scenario === s.id ? "text-lime" : "text-slate-200"}`}>{s.label}</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{s.desc}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="mt-3 w-full rounded-xl bg-lime px-4 py-2.5 text-sm font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50"
        >
          {busy ? "Running…" : "Run scenario"}
        </button>
        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300 ring-1 ring-red-400/20">{error}</p>}
        <p className="text-[10px] leading-relaxed text-slate-600">
          Each run creates a new sim-namespace device + kiosk + (for lifecycle) a ZR-SIM- rental.
          Rows stay in the sim namespace and are visible under /system/kiosks.
        </p>
      </section>

      <section className="space-y-3">
        {runs.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-5 py-10 text-sm text-slate-400">
            No runs yet. Pick a scenario and run it — results appear here as JSON.
          </p>
        ) : runs.map((r, i) => (
          <div key={i} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs font-bold text-slate-200">{r.scenario}</p>
              <p className="font-mono text-[10px] text-slate-500">{new Date(r.at).toLocaleTimeString("en-US", { timeZone: "UTC" })}Z · simulated</p>
            </div>
            <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-slate-300 ring-1 ring-white/5">
              {JSON.stringify(r.body, null, 2)}
            </pre>
          </div>
        ))}
      </section>
    </div>
  );
}
