"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Sends a marked test alert via POST /api/system/observability/alerts/test.
 * Shows the honest result: not configured (503), delivered, or failed.
 */
export function TestAlertButton({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function submit() {
    setState("loading");
    try {
      const res = await fetch("/api/system/observability/alerts/test", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { delivered?: boolean; error?: string; configured?: boolean };
      if (res.status === 503 || json.configured === false) setState("not configured");
      else if (res.ok && json.delivered) { setState("delivered"); router.refresh(); }
      else setState(json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  return (
    <button
      onClick={submit}
      disabled={state === "loading" || !configured}
      title={configured ? "POST a marked test payload to ALERT_WEBHOOK_URL" : "ALERT_WEBHOOK_URL is not configured"}
      className="rounded-full bg-lime/15 px-4 py-2 text-xs font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/25 disabled:opacity-50"
    >
      {state === "loading" ? "sending…" : state !== "idle" ? String(state).slice(0, 24) : "Send test alert"}
    </button>
  );
}
