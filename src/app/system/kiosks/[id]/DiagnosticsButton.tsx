"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Check = { name: string; ok: boolean | null; detail: string };
type Diag = {
  status: string; adapter: string; checked_at: string;
  checks: Check[]; heartbeat_age_minutes: number | null;
};

/** Runs bounded diagnostics (POST) and shows the honest result. Never claims a live ping. */
export function DiagnosticsButton({ deviceId, canManage }: { deviceId: string; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Diag | null>(null);

  if (!canManage) return <span className="text-[10px] text-slate-500">requires system.kiosks.manage</span>;

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/diagnostics`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      setResult((j as { diagnostics?: Diag }).diagnostics ?? null);
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={run}
        className="rounded-full bg-cyan-400/15 px-3 py-1.5 font-mono text-[11px] font-extrabold text-cyan-300 ring-1 ring-cyan-400/30 hover:bg-cyan-400/25 disabled:opacity-50">
        {busy ? "Running…" : "Run diagnostics"}
      </button>
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
      {result && (
        <span className="font-mono text-[10px] text-slate-300">
          → <span className="font-bold text-cyan-300">{result.status}</span>
          {" "}(adapter={result.adapter}
          {result.heartbeat_age_minutes != null ? `, heartbeat ${result.heartbeat_age_minutes}m ago` : ", no heartbeat"})
        </span>
      )}
    </span>
  );
}
