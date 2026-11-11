export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import type { ChangeRequestRow } from "@/lib/system/audit";
import { DecisionButtons } from "./DecisionButtons";

export const metadata: Metadata = { title: "Security — Change requests" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const RISK_TONE: Record<string, string> = {
  low: "bg-white/10 text-slate-300 ring-white/15",
  medium: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  high: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  critical: "bg-red-500/15 text-red-300 ring-red-400/30",
};
const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  approved: "bg-lime/15 text-lime ring-lime/30",
  rejected: "bg-red-500/15 text-red-300 ring-red-400/30",
  executed: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
};

export default async function ChangesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canDecide = roleCan(role, "system.changes.decide");

  let q = db?.from("system_change_requests")
    .select("id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at")
    .order("created_at", { ascending: false }).limit(200);
  if (q && status && ["pending", "approved", "rejected", "executed", "failed"].includes(status)) q = q.eq("status", status);
  const res = q ? await q : null;
  const rows = (res?.data ?? []) as ChangeRequestRow[];

  const filters = ["", "pending", "approved", "rejected", "executed", "failed"];
  const href = (s: string) => `/system/changes${s ? `?status=${s}` : ""}`;

  return (
    <SystemGate perm="system.changes.view">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Security</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Change requests</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              High-risk and breakglass mutations require an approved request here first. Separation of duties is
              enforced: the decider must be a different principal than the requester.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Link key={f || "all"} href={href(f)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${status === f || (!status && !f) ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>
              {f || "All"}
            </Link>
          ))}
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — change requests unavailable.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No change requests{status ? ` with status "${status}"` : ""} yet.</p>
          ) : (
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When", "Action", "Env", "Risk", "Justification", "Status", "Requester", "Decided", "Decision"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const own = user && c.requested_by === user.id;
                  const decided = c.decided_by ? c.decided_by.slice(0, 8) : "—";
                  return (
                    <tr key={c.id} className="border-b border-white/5 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(c.created_at)}</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-200">{c.action}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.environment}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${RISK_TONE[c.risk] ?? RISK_TONE.medium}`}>{c.risk}</span></td>
                      <td className="max-w-[240px] px-4 py-3 text-slate-300"><span className="line-clamp-3">{c.justification || "—"}</span></td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[c.status] ?? ""}`}>{c.status}</span></td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.requested_by.slice(0, 8)}{own ? " (you)" : ""}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{decided}{c.decided_at ? ` · ${when(c.decided_at)}` : ""}</td>
                      <td className="px-4 py-3">
                        {c.status === "pending" ? (
                          <DecisionButtons
                            changeId={c.id}
                            disabledReason={!canDecide ? "requires system.changes.decide" : own ? "separation of duties" : undefined}
                          />
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
