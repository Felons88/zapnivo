"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Toggle for a feature-flag row. Metadata only — env vars still govern runtime. */
export function FlagToggle({ flagKey, enabled, canManage }: { flagKey: string; enabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) {
    return (
      <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ring-1 ${enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-400 ring-white/15"}`}>
        {enabled ? "enabled" : "disabled"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true); setError(null);
          try {
            const res = await fetch("/api/system/flags", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: flagKey, enabled: !enabled }),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
            }
            router.refresh();
          } finally { setBusy(false); }
        }}
        className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ring-1 transition-colors disabled:opacity-50 ${enabled ? "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25" : "bg-white/10 text-slate-300 ring-white/15 hover:bg-white/20"}`}
      >
        {busy ? "…" : enabled ? "enabled — click to disable" : "disabled — click to enable"}
      </button>
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
    </span>
  );
}
