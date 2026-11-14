"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IncidentLinkType } from "@/lib/system/incidents";

const TYPES: IncidentLinkType[] = ["error_issue", "deployment", "device", "change_request", "incident", "other"];

/**
 * Evidence-link composer. POSTs /api/system/incidents/{id}/evidence with
 * { links: [{type,id,label?}] }. Stored in incidents.links jsonb, deduped
 * server-side on type+id.
 */
export function IncidentEvidenceForm({ incidentId }: { incidentId: string }) {
  const router = useRouter();
  const [type, setType] = useState<IncidentLinkType>("error_issue");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  async function submit() {
    if (!id.trim()) return;
    setState("loading");
    try {
      const res = await fetch(`/api/system/incidents/${incidentId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: [{ type, id: id.trim(), ...(label.trim() ? { label: label.trim() } : {}) }],
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (res.ok) { setId(""); setLabel(""); setState("done"); router.refresh(); }
      else if (res.status === 202) setState("pending approval");
      else setState(json.reason ?? json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <select
        value={type}
        onChange={(e) => setType(e.target.value as IncidentLinkType)}
        className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200"
        aria-label="Evidence type"
      >
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="id (uuid / fingerprint / device uid)"
        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-600"
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="label (optional)"
        className="w-32 rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-600"
      />
      <button
        onClick={submit}
        disabled={state === "loading" || !id.trim()}
        className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
      >
        {state === "loading" ? "…" : "link"}
      </button>
      {state !== "idle" && <span className="font-mono text-[10px] text-slate-400">{String(state).slice(0, 30)}</span>}
    </div>
  );
}
