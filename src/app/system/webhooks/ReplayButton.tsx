"use client";

import { useState } from "react";

/** POST /api/system/webhooks/{ref}/replay — requeue a failed/dead inbound job. */
export function ReplayButton({ refId }: { refId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function replay() {
    setState("loading");
    try {
      const res = await fetch(`/api/system/webhooks/${encodeURIComponent(refId)}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; reason?: string; status?: string };
      if (res.ok || res.status === 202) setState(json.status === "requeued" ? "done" : (json.error ?? "pending"));
      else setState(json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  if (state === "done") return <span className="font-mono text-[11px] text-lime">requeued</span>;
  return (
    <button
      onClick={replay}
      disabled={state === "loading"}
      title={typeof state === "string" && state !== "idle" && state !== "loading" ? state : "Requeue this job"}
      className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
    >
      {state === "loading" ? "…" : typeof state === "string" && state !== "idle" ? state.slice(0, 24) : "replay"}
    </button>
  );
}
