"use client";

import { useState } from "react";

type Health = { status: string; detail: string; latencyMs: number | null };

/** Per-provider "Run check" button → GET /api/system/integrations/[id]/health. */
export function HealthButtons({ id, configured }: { id: string; configured: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | Health>("idle");

  async function run() {
    setState("loading");
    try {
      const res = await fetch(`/api/system/integrations/${encodeURIComponent(id)}/health`, { cache: "no-store" });
      const json = (await res.json()) as { health?: Health; error?: string };
      setState(json.health ?? { status: "unknown", detail: json.error ?? `HTTP ${res.status}`, latencyMs: null });
    } catch {
      setState({ status: "unknown", detail: "request failed", latencyMs: null });
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={state === "loading"}
        className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
      >
        {state === "loading" ? "checking…" : "run check"}
      </button>
      {state !== "idle" && state !== "loading" && (
        <span className="max-w-[220px] text-right font-mono text-[10px] leading-tight text-slate-400" title={state.detail}>
          {state.status}{state.latencyMs != null ? ` · ${state.latencyMs}ms` : ""} — {state.detail.slice(0, 80)}
        </span>
      )}
      {!configured && state === "idle" && <span className="font-mono text-[10px] text-slate-600">skipped: unconfigured</span>}
    </div>
  );
}
