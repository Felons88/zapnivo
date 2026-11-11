"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** POST /api/system/incidents/{id}/acknowledge — stamps acknowledged_at. */
export function AcknowledgeButton({ incidentId, acknowledged, resolved }: { incidentId: string; acknowledged: boolean; resolved: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  if (resolved || acknowledged || state === "done") {
    return <span className="font-mono text-[11px] text-slate-500">{resolved ? "resolved" : "acknowledged"}</span>;
  }

  async function ack() {
    setState("loading");
    try {
      const res = await fetch(`/api/system/incidents/${incidentId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; reason?: string };
      if (res.ok) { setState("done"); router.refresh(); }
      else if (res.status === 202) setState("pending approval");
      else setState(json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  return (
    <button
      onClick={ack}
      disabled={state === "loading"}
      title={typeof state === "string" && state !== "idle" && state !== "loading" ? state : "Acknowledge incident"}
      className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
    >
      {state === "loading" ? "…" : typeof state === "string" && state !== "idle" ? state.slice(0, 24) : "acknowledge"}
    </button>
  );
}
