"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Investigation-note composer. POSTs /api/system/incidents/{id}/notes with
 * { note }. Notes are append-only audit events — they render in the incident
 * timeline after router.refresh().
 */
export function IncidentNoteForm({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function submit() {
    if (note.trim().length < 3) return;
    setState("loading");
    try {
      const res = await fetch(`/api/system/incidents/${incidentId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (res.ok) { setNote(""); setState("done"); router.refresh(); }
      else if (res.status === 202) setState("pending approval");
      else setState(json.reason ?? json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Investigation note (appended to the audit timeline)…"
        className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-600"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={state === "loading" || note.trim().length < 3}
          className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
        >
          {state === "loading" ? "…" : "add note"}
        </button>
        {state !== "idle" && <span className="font-mono text-[10px] text-slate-400">{String(state).slice(0, 30)}</span>}
      </div>
    </div>
  );
}
