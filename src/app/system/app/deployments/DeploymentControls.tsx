"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeploymentRequestRow } from "@/lib/system/deployops";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const statusTone = (s: string) =>
  s === "approved" || s === "executed" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "rejected" || s === "failed" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : "bg-amber-400/15 text-amber-300 ring-amber-400/30";

/**
 * Deployment request form + history table with per-row decision/execute actions.
 * Execution is intentionally manual-only — the execute button calls the API,
 * which always answers awaiting_manual_deploy.
 */
export function DeploymentControls({
  canManage,
  currentUserId,
  requests,
  backendConfigured,
  requestsError,
}: {
  canManage: boolean;
  currentUserId: string | null;
  requests: DeploymentRequestRow[];
  backendConfigured: boolean;
  requestsError: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ action: "deploy", targetEnv: "production", justification: "" });

  const post = async (url: string, body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setError(null); setNotice(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setNotice(`Pending approval — change request ${(j as { changeRequestId?: string }).changeRequestId ?? ""} created; a different principal must approve it under Changes first.`);
      } else if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else if ((j as { status?: string }).status === "awaiting_manual_deploy") {
        setNotice(`Request approved-state check passed: ${(j as { reason?: string }).reason ?? "deploy manually via git push / Vercel dashboard."}`);
      } else {
        setNotice("Done — history refreshed.");
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const input = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 focus:border-lime/40 focus:outline-none";

  return (
    <>
      {/* Request form */}
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="eyebrow text-slate-400">New deployment request</h2>
            <p className="mt-1 text-xs text-slate-500">
              High-risk by default: creation is gated by an approved change request (different principal).
              Approval here is the deployment-request decision; actual deploy stays manual.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">
              {open ? "Close" : "New request"}
            </button>
          )}
        </div>

        {open && canManage && (
          <div className="mt-4 grid gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 sm:grid-cols-3">
            <label className="text-[11px] text-slate-500">Action
              <select className={input} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                <option value="deploy">deploy</option>
                <option value="rollback">rollback</option>
                <option value="promote">promote</option>
              </select>
            </label>
            <label className="text-[11px] text-slate-500">Target env
              <select className={input} value={form.targetEnv} onChange={(e) => setForm({ ...form, targetEnv: e.target.value })}>
                <option value="production">production</option>
                <option value="preview">preview</option>
                <option value="development">development</option>
              </select>
            </label>
            <label className="text-[11px] text-slate-500 sm:col-span-3">Justification (required)
              <textarea className={input} rows={2} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} placeholder="What/why — e.g. ship release v1.4.2 to production" />
            </label>
            {error && <p className="font-mono text-xs text-red-300 sm:col-span-3">{error}</p>}
            <div className="sm:col-span-3">
              <button
                type="button" disabled={busy !== null || form.justification.trim().length < 10}
                onClick={() => post("/api/system/deployments", { action: form.action, targetEnv: form.targetEnv, justification: form.justification }, "create")}
                className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50"
              >
                {busy === "create" ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </div>
        )}
        {notice && <p className="mt-3 font-mono text-xs text-lime">{notice}</p>}
      </section>

      {/* History */}
      <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
        <h2 className="border-b border-white/10 px-5 py-3 eyebrow text-slate-400">Deployment requests</h2>
        {!backendConfigured ? (
          <p className="px-6 py-8 text-sm text-slate-400">Backend not configured — request history unavailable.</p>
        ) : requestsError ? (
          <p className="px-6 py-8 text-sm text-slate-400">{requestsError === "backend not configured" ? "Backend not configured." : `Request history unavailable: ${requestsError}`}</p>
        ) : requests.length === 0 ? (
          <p className="px-6 py-8 text-sm text-slate-400">No deployment requests yet. Apply migration 0045, then create the first request.</p>
        ) : (
          <table className="w-full min-w-[960px] text-left text-xs">
            <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{["When", "Action", "Target", "Justification", "Status", "Requested by", "Decided by", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const isRequester = currentUserId === r.requested_by;
                const canDecide = canManage && r.status === "pending" && !isRequester;
                const canExecute = canManage && r.status === "approved" && !isRequester;
                return (
                  <tr key={r.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(r.created_at)}</td>
                    <td className="px-4 py-3 font-mono font-bold text-lime">{r.action}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{r.target_env}</td>
                    <td className="max-w-[220px] px-4 py-3 text-slate-400">{r.justification}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{r.requested_by.slice(0, 8)}…</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{r.decided_by ? `${r.decided_by.slice(0, 8)}…` : "—"}</td>
                    <td className="px-4 py-3">
                      {(canDecide || canExecute) && (
                        <span className="inline-flex flex-wrap gap-1.5">
                          {canDecide && (
                            <>
                              <button type="button" disabled={busy !== null} onClick={() => post(`/api/system/deployments/${r.id}/decision`, { decision: "approved" }, `decide-${r.id}`)} className="rounded-full bg-lime/15 px-2.5 py-1 font-mono text-[10px] font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/25 disabled:opacity-50">approve</button>
                              <button type="button" disabled={busy !== null} onClick={() => post(`/api/system/deployments/${r.id}/decision`, { decision: "rejected" }, `decide-${r.id}`)} className="rounded-full bg-red-500/15 px-2.5 py-1 font-mono text-[10px] font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">reject</button>
                            </>
                          )}
                          {canExecute && (
                            <button type="button" disabled={busy !== null} onClick={() => post(`/api/system/deployments/${r.id}/execute`, {}, `exec-${r.id}`)} className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[10px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/20 disabled:opacity-50">execute →</button>
                          )}
                        </span>
                      )}
                      {r.status === "pending" && isRequester && <span className="font-mono text-[10px] text-slate-600">awaiting another principal</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!canManage && backendConfigured && requests.length > 0 && (
          <p className="border-t border-white/10 px-5 py-3 text-xs text-slate-500">View-only for your role — decisions and requests need system.deployments.manage.</p>
        )}
      </section>
    </>
  );
}
