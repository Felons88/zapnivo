"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Kill-switch toggle + tool allowlist editor for one agent.
 * Both POST to audited /api/system/* routes; pending change requests surface
 * honestly (202 → message) instead of pretending the change applied.
 */
export function AgentControls({
  agentId,
  enabled,
  tools,
  canManage,
}: {
  agentId: string;
  enabled: boolean;
  tools: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tools.join(", "));

  if (!canManage) {
    return (
      <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] font-bold ring-1 ${enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>
        {enabled ? "enabled" : "disabled"}
      </span>
    );
  }

  const post = async (url: string, body: unknown) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({})) as { error?: string; message?: string; status?: string };
      if (res.status === 202 || j.status === "pending") {
        setMsg("⏳ change request created — awaiting approval");
      } else if (!res.ok) {
        setMsg(`✗ ${j.error ?? `HTTP ${res.status}`}`);
      } else {
        setMsg("✓ applied");
        setEditing(false);
      }
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => post(`/api/system/ai/agents/${encodeURIComponent(agentId)}/kill`, { enabled: !enabled })}
        className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ring-1 transition-colors disabled:opacity-50 ${enabled ? "bg-red-500/15 text-red-300 ring-red-400/30 hover:bg-red-500/25" : "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25"}`}
      >
        {busy ? "…" : enabled ? "kill switch" : "re-enable"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setEditing((v) => !v)}
        className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-300 ring-1 ring-white/15 hover:bg-white/20"
      >
        {editing ? "close tools" : "tools"}
      </button>
      {msg && <span className="font-mono text-[10px] text-amber-300">{msg}</span>}
      {editing && (
        <span className="flex w-full items-center gap-2 pt-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="tool.name, other.tool"
            className="w-72 rounded-lg border border-white/15 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-lime/50"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => post(`/api/system/ai/agents/${encodeURIComponent(agentId)}/tools`, {
              tools: draft.split(",").map((s) => s.trim()).filter(Boolean),
            })}
            className="rounded-full bg-lime px-3 py-1 font-mono text-[11px] font-bold text-ink disabled:opacity-50"
          >
            save tools
          </button>
        </span>
      )}
    </span>
  );
}
