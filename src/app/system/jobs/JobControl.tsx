"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pause/resume toggle for a vercel.json cron job.
 * POST /api/system/jobs/control { job, paused } — requires
 * system.webhooks.retry + step-up elevation (jobs.paused is high-risk).
 * Financial/settlement jobs are denylisted server-side (403).
 */
export function JobControlButton({ job, paused }: { job: string; paused: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function toggle() {
    setState("loading");
    try {
      const res = await fetch("/api/system/jobs/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job, paused: !paused }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      if (res.ok) {
        setState("done");
        router.refresh();
      } else {
        setState(json.code === "step_up_required" ? "needs MFA step-up" : (json.error ?? `HTTP ${res.status}`));
      }
    } catch {
      setState("request failed");
    }
  }

  const label = paused ? "resume" : "pause";
  return (
    <button
      onClick={toggle}
      disabled={state === "loading"}
      title={typeof state === "string" && state !== "idle" && state !== "loading" && state !== "done" ? state : `${label} ${job} (requires step-up elevation)`}
      className={`rounded-full px-3 py-1 text-[11px] font-bold ring-1 disabled:opacity-50 ${
        paused
          ? "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25"
          : "bg-white/10 text-slate-200 ring-white/15 hover:bg-white/15"
      }`}
    >
      {state === "loading" ? "…" : state === "done" ? "updated" : label}
    </button>
  );
}
