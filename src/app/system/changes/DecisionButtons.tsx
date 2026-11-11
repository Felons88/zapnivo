"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Approve/reject buttons for a pending change request (deciders only). */
export function DecisionButtons({ changeId, disabledReason }: { changeId: string; disabledReason?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (disabledReason) return <span className="text-[10px] text-slate-500">{disabledReason}</span>;

  const decide = async (decision: "approved" | "rejected") => {
    const note = decision === "rejected" ? window.prompt("Rejection reason (optional, audited):") ?? undefined : undefined;
    if (decision === "rejected" && note === null) return;
    setBusy(decision); setError(null);
    try {
      const res = await fetch(`/api/system/changes/${changeId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={busy !== null} onClick={() => decide("approved")}
        className="rounded-full bg-lime px-3 py-1 font-mono text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
        {busy === "approved" ? "…" : "approve"}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => decide("rejected")}
        className="rounded-full bg-red-500/15 px-3 py-1 font-mono text-[11px] font-extrabold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">
        {busy === "rejected" ? "…" : "reject"}
      </button>
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
    </span>
  );
}
