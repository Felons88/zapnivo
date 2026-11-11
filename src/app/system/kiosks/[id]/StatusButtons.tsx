"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Target = { status: string; risk: "low" | "medium" | "high" | "critical" };

/** Lifecycle transition buttons. Allowed targets + risk are computed server-side. */
export function StatusButtons({ deviceId, targets }: { deviceId: string; targets: Target[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  if (targets.length === 0) return <span className="text-[10px] text-slate-500">terminal state — no transitions</span>;

  const go = async (status: string, risk: string) => {
    const high = risk === "high" || risk === "critical";
    const justification = window.prompt(
      high ? `Transition to "${status}" requires an approved change request (risk: ${risk}). Justification (audited):` : `Justification for → ${status} (optional, audited):`,
    );
    if (justification === null) return;
    setBusy(status); setError(null); setPending(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, justification: justification || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setPending((j as { changeRequestId?: string }).changeRequestId ?? "created");
      } else if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const tone = (risk: string) =>
    risk === "high" || risk === "critical" ? "bg-red-500/15 text-red-300 ring-red-400/30 hover:bg-red-500/25"
    : risk === "medium" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30 hover:bg-amber-400/25"
    : "bg-white/10 text-slate-200 ring-white/15 hover:bg-white/15";

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {targets.map((t) => (
        <button key={t.status} type="button" disabled={busy !== null}
          onClick={() => go(t.status, t.risk)} title={`risk: ${t.risk}`}
          className={`rounded-full px-3 py-1 font-mono text-[11px] font-extrabold ring-1 disabled:opacity-50 ${tone(t.risk)}`}>
          {busy === t.status ? "…" : `→ ${t.status}`}
        </button>
      ))}
      {pending && <span className="font-mono text-[10px] text-amber-300">change request {String(pending).slice(0, 8)} pending approval</span>}
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
    </span>
  );
}
