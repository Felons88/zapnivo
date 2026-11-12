export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { RETENTION_POLICY, PRESERVED_TABLES, listRetentionRuns } from "@/lib/system/retention";
import { RetentionControls } from "./RetentionControls";

export const metadata: Metadata = { title: "Settings — Data retention" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function RetentionPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.deployments.manage");
  const { runs } = db ? await listRetentionRuns(db, 20) : { runs: [] as Record<string, unknown>[] };

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Settings</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Data retention</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Code-defined policy (<code className="font-mono text-xs">src/lib/system/retention.ts</code>) executed by the
            daily cron (<code className="font-mono text-xs">/api/cron/retention</code>, 04:00 UTC) and on demand.
            Deletes are bounded batches keyed by primary key — never a table scan, never a preserved-class table.
          </p>
        </div>

        <RetentionControls canManage={canManage} />

        {/* Policy table */}
        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <h2 className="border-b border-white/10 px-5 py-3 eyebrow text-slate-400">Telemetry class — auto-expire</h2>
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{["Table", "Keep", "Time column", "Filter", "Notes", "Index"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {RETENTION_POLICY.map((r) => (
                <tr key={r.table} className="border-b border-white/5 align-top last:border-0">
                  <td className="px-4 py-3 font-mono font-bold text-lime">{r.table}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-200">{r.retentionDays}d</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{r.timeColumn}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{r.statusColumn ? `${r.statusColumn}=${r.statusValue}` : "—"}</td>
                  <td className="max-w-xs px-4 py-3 text-slate-400">{r.description}</td>
                  <td className="max-w-[180px] px-4 py-3 font-mono text-[10px] text-slate-500">{r.indexNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Preserved class */}
        <section className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-5">
          <h2 className="eyebrow text-amber-300">Preserved class — never auto-deleted</h2>
          <p className="mt-2 text-xs text-slate-400">
            Audit, legal, financial, security and identity records. The denylist is enforced in code
            (<code className="font-mono">isPreservedTable</code>) before any delete — requesting one of these
            tables returns a refusal, not a sweep.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PRESERVED_TABLES.map((t) => (
              <code key={t} className="rounded bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-white/10">{t}</code>
            ))}
          </div>
        </section>

        {/* Run history */}
        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <h2 className="border-b border-white/10 px-5 py-3 eyebrow text-slate-400">Recent runs</h2>
          {!db ? (
            <p className="px-6 py-8 text-sm text-slate-400">Backend not configured — run history unavailable.</p>
          ) : runs.length === 0 ? (
            <p className="px-6 py-8 text-sm text-slate-400">No retention runs recorded yet. Apply migration 0045, then run a dry-run.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When", "Mode", "Status", "Tables", "Deleted", "Duration", "Error"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const row = r as { id: string; mode: string; status: string; tables: string[]; deleted_counts: Record<string, number>; duration_ms: number | null; error: string | null; created_at: string };
                  const total = Object.values(row.deleted_counts ?? {}).reduce((a, b) => a + (b || 0), 0);
                  return (
                    <tr key={row.id} className="border-b border-white/5 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(row.created_at)}</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-200">{row.mode}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${row.status === "completed" ? "bg-lime/15 text-lime ring-lime/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>{row.status}</span>
                      </td>
                      <td className="max-w-[220px] px-4 py-3 font-mono text-[10px] text-slate-500">{(row.tables ?? []).join(", ")}</td>
                      <td className="px-4 py-3 font-mono text-slate-200">{total}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{row.duration_ms != null ? `${row.duration_ms}ms` : "—"}</td>
                      <td className="max-w-[200px] px-4 py-3 font-mono text-[10px] text-red-300/80">{row.error ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {!canManage && <p className="text-xs text-slate-500">Your role can view retention policy and history but not trigger runs (requires system.deployments.manage).</p>}
      </div>
    </SystemGate>
  );
}
