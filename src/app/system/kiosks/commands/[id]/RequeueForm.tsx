"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Controlled requeue form — POST /api/system/commands/[id]/requeue.
 * Physical commands additionally require: step-up MFA (server-side), the
 * allowPhysical opt-in, and — when a contradictory ack exists — evidence_ref.
 * The server re-checks everything; this form only collects the operator input.
 */
export function RequeueForm({
  commandId, command, physical, evidenceCommand, requeueable,
}: {
  commandId: string;
  command: string;
  physical: boolean;
  /** dispense|return_slot — evidence_ref field shown. */
  evidenceCommand: boolean;
  requeueable: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [allowPhysical, setAllowPhysical] = useState(false);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!requeueable) {
    return (
      <p className="text-xs text-slate-500">
        This command is not in a requeueable state. unknown_outcome / requires_investigation must be
        resolved by a human investigation first — retries are never automatic for physical commands.
      </p>
    );
  }

  const submit = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await fetch(`/api/system/commands/${commandId}/requeue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          reason,
          ...(physical ? { allowPhysical } : {}),
          ...(evidenceCommand && evidenceRef.trim() ? { evidence_ref: evidenceRef.trim() } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string; code?: string; attempt?: number; status?: string; contradictory_ack?: boolean;
      };
      if (!res.ok) {
        setError(`${j.code ? `[${j.code}] ` : ""}${j.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setNote(`requeued — attempt ${j.attempt ?? "?"}, status ${j.status ?? "queued"}${j.contradictory_ack ? " (contradictory ack was present; evidence accepted)" : ""}`);
      setReason(""); setConfirm(false); setAllowPhysical(false); setEvidenceRef("");
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <label className="block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
        Reason (≥10 chars — written to audit)
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
          placeholder="e.g. Hardware confirmed motor_stall; slot verified empty on-site."
          className="mt-1 block w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200 focus:border-lime/50 focus:outline-none" />
      </label>
      {evidenceCommand && (
        <label className="block text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
          Evidence ref (required only when a contradictory ack exists — resolved exception uuid or failure device_events id)
          <input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} maxLength={120}
            className="mt-1 block w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200 focus:border-lime/50 focus:outline-none" />
        </label>
      )}
      {physical && (
        <label className="flex items-start gap-2 text-[11px] font-bold text-orange-200">
          <input type="checkbox" checked={allowPhysical} onChange={(e) => setAllowPhysical(e.target.checked)} className="mt-0.5 accent-orange-400" />
          <span>
            This is a <strong>physical</strong> command ({command}). Retrying can actuate hardware —
            confirm the previous attempt did not complete, and expect a step-up MFA check.
          </span>
        </label>
      )}
      <label className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="accent-lime" />
        I confirm this retry is intentional and reviewed
      </label>
      <div className="flex items-center gap-3">
        <button type="button" disabled={busy || !confirm || reason.trim().length < 10 || (physical && !allowPhysical)}
          onClick={submit}
          className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-40">
          {busy ? "Requeueing…" : `Requeue ${command}`}
        </button>
        {note && <span className="font-mono text-[10px] text-lime">{note}</span>}
        {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}
