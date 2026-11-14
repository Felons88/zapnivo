"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-campaign lifecycle buttons. Each POSTs {action} to
 * /api/system/updates/campaigns/[id]; firmware/software approve+activate will
 * surface a 403 step_up_required until the operator completes MFA elevation.
 */
const ACTIONS: Record<string, { label: string; action: string; danger?: boolean; elev?: boolean }[]> = {
  pending_approval: [{ label: "Approve", action: "approve", elev: true }],
  draft: [{ label: "Submit", action: "submit" }],
  approved: [{ label: "Activate", action: "activate", elev: true }, { label: "Cancel", action: "cancel", danger: true }],
  scheduled: [{ label: "Activate", action: "activate", elev: true }, { label: "Cancel", action: "cancel", danger: true }],
  active: [
    { label: "Pause", action: "pause" },
    { label: "Cancel", action: "cancel", danger: true },
  ],
  paused: [{ label: "Resume", action: "resume" }, { label: "Cancel", action: "cancel", danger: true }],
  blocked: [{ label: "Cancel", action: "cancel", danger: true }],
};

export function CampaignActions({ campaignId, status, canManage, needsElevation }: {
  campaignId: string; status: string; canManage: boolean; needsElevation: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = ACTIONS[status] ?? [];
  if (!canManage || actions.length === 0) {
    return status in ACTIONS ? null : <span className="font-mono text-[10px] text-slate-600">—</span>;
  }

  const run = async (action: string) => {
    let reason: string | undefined;
    if (action === "pause" || action === "cancel") {
      const r = window.prompt(`${action} campaign — reason (optional):`);
      if (r === null) return; // operator dismissed the prompt
      reason = r.trim() || undefined;
    }
    setBusy(action); setError(null);
    try {
      const res = await fetch(`/api/system/updates/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`${action}: ${(j as { error?: string }).error ?? `HTTP ${res.status}`}`);
        return;
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {actions.map((a) => (
          <button key={a.action} type="button" disabled={busy !== null} onClick={() => run(a.action)}
            title={a.elev && needsElevation ? "requires recent MFA elevation" : undefined}
            className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 disabled:opacity-40 ${
              a.danger
                ? "bg-red-500/10 text-red-300 ring-red-400/30 hover:bg-red-500/20"
                : "bg-white/10 text-slate-200 ring-white/15 hover:bg-white/15"
            }`}>
            {busy === a.action ? "…" : a.label}
            {a.elev && needsElevation ? " (MFA)" : ""}
          </button>
        ))}
      </div>
      {error && <span className="max-w-[220px] font-mono text-[9px] text-red-300">{error}</span>}
    </div>
  );
}
