export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listPendingApprovals, approvalSummary } from "@/lib/system/approvals";
import { DecisionButtons } from "../changes/DecisionButtons";

export const metadata: Metadata = { title: "Pending approvals" };

const RISK_TONE: Record<string, string> = {
  low: "bg-white/10 text-slate-300 ring-white/15",
  medium: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  high: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  critical: "bg-red-500/15 text-red-300 ring-red-400/30",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function ApprovalsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canDecide = roleCan(role, "system.changes.decide");
  const [{ rows, configured }, summary] = await Promise.all([
    listPendingApprovals(db),
    approvalSummary(db),
  ]);

  return (
    <SystemGate perm="system.changes.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Security</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Pending approvals</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Change requests awaiting a decision, oldest first. Approving or rejecting uses the same
              audited endpoint as the full queue — separation of duties is enforced server-side: you
              can never decide a request you submitted yourself.
            </p>
          </div>
          <Link href="/system/changes" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            Full change history →
          </Link>
        </div>

        {summary && (
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.05] p-4">
              <p className="font-mono text-2xl font-bold text-amber-300">{summary.pending}</p>
              <p className="mt-1 text-[11px] text-slate-400">pending total</p>
            </div>
            {(["critical", "high", "medium", "low"] as const).map((r) => (
              <div key={r} className="rounded-xl border border-white/[0.08] bg-white/[0.05] p-4">
                <p className={`font-mono text-2xl font-bold ${r === "critical" ? "text-red-300" : r === "high" ? "text-orange-300" : r === "medium" ? "text-amber-300" : "text-slate-300"}`}>{summary.byRisk[r]}</p>
                <p className="mt-1 text-[11px] text-slate-400">{r} risk</p>
              </div>
            ))}
          </div>
        )}
        {summary?.oldestPendingAt && (
          <p className="text-xs text-slate-500">
            Oldest pending request: <span className="font-mono text-slate-300">{when(summary.oldestPendingAt)}</span>
            {!canDecide && " — your role can view but not decide (needs system.changes.decide)."}
          </p>
        )}

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!configured ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — approval queue unavailable.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">
              No pending change requests — the queue is clear. High-risk and breakglass mutations will
              appear here when requested.
            </p>
          ) : (
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Requested", "Age", "Action", "Env", "Risk", "Justification", "Requester", "Decision"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const own = user && c.requested_by === user.id;
                  return (
                    <tr key={c.id} className="border-b border-white/5 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(c.created_at)}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{c.ageHours}h</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-200">{c.action}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.environment}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${RISK_TONE[c.risk] ?? RISK_TONE.medium}`}>{c.risk}</span></td>
                      <td className="max-w-[280px] px-4 py-3 text-slate-300"><span className="line-clamp-3">{c.justification || "—"}</span></td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.requested_by.slice(0, 8)}{own ? " (you)" : ""}</td>
                      <td className="px-4 py-3">
                        <DecisionButtons
                          changeId={c.id}
                          disabledReason={!canDecide ? "requires system.changes.decide" : own ? "separation of duties" : undefined}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <p className="text-xs text-slate-500">
          Decisions are audited as <code className="font-mono">change.approved</code> /{" "}
          <code className="font-mono">change.rejected</code> and appear in the{" "}
          <Link href="/system/activity?action=change." className="underline hover:text-white">activity feed</Link>.
          Requesting a change: <code className="font-mono">POST /api/system/changes</code>.
        </p>
      </div>
    </SystemGate>
  );
}
