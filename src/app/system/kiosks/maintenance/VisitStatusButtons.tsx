"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAINTENANCE_TRANSITIONS, type MaintenanceStatus, type MaintenanceVisitRow } from "@/lib/system/device-config.shared";

/** Legal next-status buttons for one visit → PATCH /api/system/kiosks/maintenance/[id]. */
export function VisitStatusButtons({ visit }: { visit: MaintenanceVisitRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = MAINTENANCE_TRANSITIONS[visit.status as MaintenanceStatus] ?? [];
  if (targets.length === 0) return <span className="font-mono text-[10px] text-slate-600">terminal</span>;

  const go = async (status: string) => {
    setBusy(status); setError(null);
    try {
      const res = await fetch(`/api/system/kiosks/maintenance/${visit.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      router.refresh();
    } finally { setBusy(null); }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {targets.map((t) => (
        <button key={t} type="button" disabled={busy !== null} onClick={() => go(t)}
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 disabled:opacity-50 ${
            t === "completed" ? "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25"
            : t === "cancelled" ? "bg-red-500/15 text-red-300 ring-red-400/30 hover:bg-red-500/25"
            : "bg-white/10 text-slate-200 ring-white/15 hover:bg-white/15"}`}>
          {busy === t ? "…" : `→ ${t}`}
        </button>
      ))}
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
    </span>
  );
}
