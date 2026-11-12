"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IncidentStatus } from "@/lib/system/incidents";

/**
 * Incident lifecycle transition control. POSTs
 * /api/system/incidents/{id}/transition with { to_status, reason? }.
 * Reason is mandatory when the target is 'reopened' (enforced server-side too).
 */
export function IncidentActions({
  incidentId,
  current,
  targets,
}: {
  incidentId: string;
  current: IncidentStatus;
  targets: readonly IncidentStatus[];
}) {
  const router = useRouter();
  const [to, setTo] = useState<string>(targets[0] ?? "");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  if (targets.length === 0) {
    return <span className="font-mono text-[11px] text-slate-600">terminal</span>;
  }

  const needsReason = to === "reopened";

  async function submit() {
    if (!to) return;
    setState("loading");
    try {
      const res = await fetch(`/api/system/incidents/${incidentId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_status: to, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (res.ok) { setState("done"); router.refresh(); }
      else if (res.status === 202) setState("pending approval");
      else setState(json.reason ?? json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  if (state === "done") return <span className="font-mono text-[11px] text-lime">transitioned</span>;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200"
          aria-label="Next incident status"
        >
          {targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button
          onClick={submit}
          disabled={state === "loading" || !to || (needsReason && reason.trim().length < 3)}
          title={typeof state === "string" && state !== "idle" && state !== "loading" ? state : "Apply transition"}
          className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
        >
          {state === "loading" ? "…" : typeof state === "string" && state !== "idle" ? state.slice(0, 20) : "transition"}
        </button>
      </div>
      {needsReason && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reopen reason (required)"
          className="w-44 rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-200 placeholder:text-slate-600"
        />
      )}
      <span className="font-mono text-[9px] text-slate-600">from: {current}</span>
    </div>
  );
}
