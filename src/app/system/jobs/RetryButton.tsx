"use client";

import { useState } from "react";

/** POST /api/system/jobs/email-outbox/{id}/retry — requeue a failed outbox row. */
export function RetryButton({ emailId }: { emailId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function retry() {
    setState("loading");
    try {
      const res = await fetch(`/api/system/jobs/email-outbox/${encodeURIComponent(emailId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok) setState("done");
      else setState(json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  if (state === "done") return <span className="font-mono text-[11px] text-lime">queued</span>;
  return (
    <button
      onClick={retry}
      disabled={state === "loading"}
      title={typeof state === "string" && state !== "idle" && state !== "loading" ? state : "Requeue for next mailer flush"}
      className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
    >
      {state === "loading" ? "…" : typeof state === "string" && state !== "idle" ? state.slice(0, 24) : "retry"}
    </button>
  );
}
