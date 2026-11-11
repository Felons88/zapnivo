"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FIN_CASE_STATUSES } from "@/lib/finance/investigations";

async function post(path: string, body: object) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data as Record<string, unknown> & { error?: string } };
}

const label = (s: string) => s.replace(/_/g, " ");

/**
 * Staff controls for one investigation case. The decide form is the ONLY place a
 * human marks a case approved/denied — it never calls a refund endpoint; refund
 * execution stays in the existing staff refund route.
 */
export function CaseActions({ caseId, status, decision, paymentId, canDecide }: {
  caseId: string; status: string; decision: string | null;
  paymentId: string | null; canDecide: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rationale, setRationale] = useState("");
  const [note, setNote] = useState("");
  const [newStatus, setNewStatus] = useState("");

  async function go(key: string, path: string, body: object) {
    setBusy(key); setMsg(null);
    const { ok, data } = await post(path, body);
    setBusy(null);
    setMsg({ ok, text: (data.error as string) ?? "Done." });
    if (ok) router.refresh();
  }

  const decided = decision != null || status === "approved_action" || status === "denied";

  return (
    <div className="space-y-4 rounded-2xl border border-mist bg-white p-5 shadow-sm">
      <div className="flex flex-wrap gap-2">
        <button disabled={!!busy} onClick={() => go("collect", `/api/admin/finance/investigations/${caseId}/collect`, {})}
          className="min-h-10 rounded-full border border-ink/30 px-4 text-sm font-bold disabled:opacity-40">
          {busy === "collect" ? "Collecting…" : "Re-collect evidence"}
        </button>
        <button disabled={!!busy} onClick={() => go("recommend", `/api/admin/finance/investigations/${caseId}/recommend`, {})}
          className="min-h-10 rounded-full border border-ink/30 px-4 text-sm font-bold disabled:opacity-40">
          {busy === "recommend" ? "Analyzing…" : "Run recommendation"}
        </button>
      </div>

      {/* Status move */}
      {!decided && (
        <div className="flex flex-wrap items-center gap-2 border-t border-mist pt-4">
          <label className="text-xs font-extrabold uppercase tracking-wider text-graphite">Set status</label>
          <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="rounded-lg border border-silver/70 px-3 py-2 text-sm font-bold">
            <option value="">Choose…</option>
            {FIN_CASE_STATUSES.filter((s) => s !== status && s !== "approved_action" && s !== "denied").map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
          <button disabled={!newStatus || !!busy} onClick={() => { go("status", `/api/admin/finance/investigations/${caseId}/status`, { op: "status", status: newStatus }); setNewStatus(""); }}
            className="min-h-10 rounded-full bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">Move</button>
        </div>
      )}

      {/* Internal note */}
      <div className="flex gap-2 border-t border-mist pt-4">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note (visible on timeline)" maxLength={2000}
          className="min-w-0 flex-1 rounded-lg border border-silver/70 px-3 py-2 text-sm" />
        <button disabled={!note.trim() || !!busy} onClick={() => { go("note", `/api/admin/finance/investigations/${caseId}/status`, { op: "note", note }); setNote(""); }}
          className="min-h-10 rounded-full border border-ink/30 px-4 text-sm font-bold disabled:opacity-40">Add note</button>
      </div>

      {/* Human decision — staff only. Never executes a refund itself. */}
      {canDecide && !decided && (
        <div className="space-y-2 rounded-xl bg-mist/50 p-4">
          <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Human decision</p>
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} maxLength={2000}
            placeholder="Rationale (required) — what did you verify, and what action should follow?"
            className="w-full rounded-lg border border-silver/70 bg-white px-3 py-2 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button disabled={rationale.trim().length < 5 || !!busy}
              onClick={() => go("approve", `/api/admin/finance/investigations/${caseId}/decide`, { decision: "approved", rationale })}
              className="min-h-10 rounded-full bg-forest px-5 text-sm font-bold text-white disabled:opacity-40">
              {busy === "approve" ? "…" : "Approve action"}
            </button>
            <button disabled={rationale.trim().length < 5 || !!busy}
              onClick={() => go("deny", `/api/admin/finance/investigations/${caseId}/decide`, { decision: "denied", rationale })}
              className="min-h-10 rounded-full border border-ink/30 px-5 text-sm font-bold disabled:opacity-40">
              {busy === "deny" ? "…" : "Deny"}
            </button>
          </div>
          <p className="text-xs text-graphite">Approving records your decision only — it does not move money. Issue any refund afterwards via the staff refund flow.</p>
        </div>
      )}

      {/* After approval: link to the existing refund route flow */}
      {decision === "approved" && paymentId && (
        <div className="rounded-xl border border-lime bg-lime/20 p-4 text-sm">
          <p className="font-bold">Action approved.</p>
          <p className="mt-1 text-graphite">
            To issue the refund, open the rental/payment in <Link href="/admin/rentals" className="font-bold text-forest underline">Rentals</Link> and use the staff refund
            {" "}control for payment <code className="text-xs">{paymentId.slice(0, 8)}…</code> — it enforces capture limits and the two-person rule.
          </p>
        </div>
      )}
      {decided && !paymentId && decision === "approved" && (
        <p className="rounded-xl border border-lime bg-lime/20 p-3 text-sm">Action approved — no payment is linked to this case, so there is nothing to refund.</p>
      )}

      {msg && <p className={`text-sm font-semibold ${msg.ok ? "text-forest" : "text-red-700"}`}>{msg.text}</p>}
      {decision && <p className="text-xs text-graphite">Decision: <b>{label(decision)}</b></p>}
    </div>
  );
}
