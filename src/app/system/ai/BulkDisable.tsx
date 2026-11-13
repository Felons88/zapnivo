"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Scoped bulk-disable for NONESSENTIAL agents. Posts an explicit id list to
 * /api/system/ai/agents/bulk — the route requires step-up elevation (403
 * step_up_required → honest message) and a high-risk change request for
 * breakglass/high-risk contexts. There is no "disable all" option.
 */
export function BulkDisable({ agentIds, canManage }: { agentIds: string[]; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (!canManage || agentIds.length === 0) return null;

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/system/ai/agents/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_ids: agentIds, reason: reason.trim() || undefined }),
      });
      const j = await res.json().catch(() => ({})) as {
        error?: string; code?: string; summary?: string; status?: string; message?: string;
        disabled?: string[]; skipped?: { id: string; reason: string }[];
      };
      if (res.status === 202 || j.status === "pending") {
        setMsg("⏳ change request created — awaiting approval");
      } else if (res.status === 403 && j.code === "step_up_required") {
        setMsg("🔒 step-up verification required — complete MFA step-up under Security → MFA, then retry");
      } else if (!res.ok) {
        setMsg(`✗ ${j.error ?? `HTTP ${res.status}`}`);
      } else {
        setMsg(`✓ ${j.summary ?? `disabled ${j.disabled?.length ?? 0} agent(s)`}`);
        setOpen(false);
        setReason("");
      }
      router.refresh();
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-red-500/15 px-4 py-2 text-xs font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25"
      >
        Disable nonessential agents ({agentIds.length})
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2">
      <span className="font-mono text-[10px] text-red-200">
        will disable {agentIds.length} agent(s): {agentIds.slice(0, 6).join(", ")}{agentIds.length > 6 ? "…" : ""}
      </span>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="reason (min 10 chars)"
        className="w-56 rounded-lg border border-white/15 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-red-400/50"
      />
      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="rounded-full bg-red-500 px-3 py-1 font-mono text-[11px] font-bold text-white disabled:opacity-50"
      >
        {busy ? "…" : "confirm disable"}
      </button>
      <button type="button" onClick={() => { setOpen(false); setMsg(null); }} className="font-mono text-[10px] text-slate-400 hover:text-slate-200">cancel</button>
      {msg && <span className="w-full font-mono text-[10px] text-amber-300">{msg}</span>}
    </span>
  );
}
