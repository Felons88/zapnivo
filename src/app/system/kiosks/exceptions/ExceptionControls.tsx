"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ExceptionState } from "@/lib/system/exceptions";

export type AssigneeOption = { id: string; label: string };

/**
 * Exception workflow controls. PATCHes /api/system/exceptions/{id} with the
 * discriminated union: transition | assign | note. Reason is mandatory when
 * the target is 'reopened' (enforced server-side too). `assignees` is null
 * when the viewer lacks the directory permission — assignment then shows the
 * raw id only.
 */
export function ExceptionControls({
  exceptionId,
  current,
  targets,
  assignedTo,
  assignees,
}: {
  exceptionId: string;
  current: ExceptionState;
  targets: readonly ExceptionState[];
  assignedTo: string | null;
  assignees: AssigneeOption[] | null;
}) {
  const router = useRouter();
  const [to, setTo] = useState<string>(targets[0] ?? "");
  const [reason, setReason] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState<string>(assignedTo ?? "");
  const [state, setState] = useState<string>("idle");
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setState("loading");
    try {
      const res = await fetch(`/api/system/exceptions/${exceptionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string; reason?: string; financial_review_required?: boolean;
      };
      if (res.ok) {
        setState(json.financial_review_required ? "done — financial review still owed" : "done");
        router.refresh();
        return true;
      }
      if (res.status === 202) setState("pending approval");
      else setState(json.reason ?? json.error ?? `HTTP ${res.status}`);
      return false;
    } catch {
      setState("request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const needsReason = to === "reopened";
  const resolving = to === "resolved";

  return (
    <div className="mt-3 space-y-4">
      {/* Transition */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Transition</p>
        {targets.length === 0 ? (
          <p className="mt-1 font-mono text-[11px] text-slate-600">terminal state — no outgoing transitions</p>
        ) : (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200"
                aria-label="Next exception state"
              >
                {targets.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                onClick={() => patch({ action: "transition", to_status: to, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(resolutionNotes.trim() ? { resolution_notes: resolutionNotes.trim() } : {}) })}
                disabled={busy || !to || (needsReason && reason.trim().length < 3)}
                className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
              >
                {busy && state === "loading" ? "…" : "transition"}
              </button>
            </div>
            {needsReason && (
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="reopen reason (required, min 3 chars)"
                className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-200 placeholder:text-slate-600"
              />
            )}
            {!needsReason && (
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="reason / note (optional)"
                className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-200 placeholder:text-slate-600"
              />
            )}
            {resolving && (
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                placeholder="resolution notes (optional — record what was verified; does not settle money)"
                rows={2}
                className="w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[10px] text-slate-200 placeholder:text-slate-600"
              />
            )}
            <span className="font-mono text-[9px] text-slate-600">
              from: {current} → {to}
              {state !== "idle" && state !== "loading" ? ` · ${state}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Assignment */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Assignment</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          {assignees ? (
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="max-w-[220px] rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200"
              aria-label="Assignee"
            >
              <option value="">unassigned</option>
              {assignees.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          ) : (
            <span className="font-mono text-[11px] text-slate-400">{assignedTo ? `${assignedTo.slice(0, 8)}…` : "unassigned"}</span>
          )}
          <button
            onClick={() => patch({ action: "assign", assigned_to: assignee || null })}
            disabled={busy || assignee === (assignedTo ?? "")}
            className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
          >
            assign
          </button>
        </div>
      </div>

      {/* Note */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Investigation note</p>
        <div className="mt-1.5 flex items-start gap-1.5">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="what did you find? (appended to the exception's note thread)"
            rows={2}
            className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200 placeholder:text-slate-600"
          />
          <button
            onClick={async () => {
              if (!note.trim()) return;
              const ok = await patch({ action: "note", text: note.trim() });
              if (ok) setNote("");
            }}
            disabled={busy || !note.trim()}
            className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
          >
            add note
          </button>
        </div>
      </div>
    </div>
  );
}
