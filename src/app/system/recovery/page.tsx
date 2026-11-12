export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getRecoveryFacts, RESTORE_RUNBOOK, listRecoveryTests, RECOVERY_METHODS } from "@/lib/system/recovery";
import { RecordTestForm } from "./RecordTestForm";

export const metadata: Metadata = { title: "Recovery — Disaster recovery" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

export default async function RecoveryPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canRecord = roleCan(role, "system.changes.request");
  const facts = getRecoveryFacts();
  const { tests } = db ? await listRecoveryTests(db, 50) : { tests: [] as Awaited<ReturnType<typeof listRecoveryTests>>["tests"] };

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Resilience</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Disaster recovery</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Backup health is <strong className="text-amber-300">managed by Supabase and cannot be verified from this
            app</strong> — there is no management API token. Everything below is either a truthful statement or an
            explicitly unverified placeholder. Restore tests are recorded manually after a human performs them.
          </p>
        </div>

        {/* Honest facts */}
        <div className="grid gap-4 lg:grid-cols-3">
          <section className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-5">
            <h2 className="eyebrow text-amber-300">Backup status</h2>
            <p className="mt-3 font-mono text-xs font-bold text-amber-200">{facts.backupStatus}</p>
            <p className="mt-2 text-xs text-slate-400">{facts.backupDetail}</p>
          </section>
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">PITR</h2>
            <p className="mt-3 font-mono text-xs font-bold text-slate-200">{facts.pitrStatus}</p>
            <p className="mt-2 text-xs text-slate-400">Point-in-time recovery is a Supabase plan/add-on feature — confirm availability in Dashboard → Database → Backups.</p>
          </section>
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
            <h2 className="eyebrow text-slate-400">RPO / RTO</h2>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">RPO target</dt><dd className="font-mono text-slate-200">{facts.rpoTargetMinutes ?? "unverified"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">RTO target</dt><dd className="font-mono text-slate-200">{facts.rtoTargetMinutes ?? "unverified"}</dd></div>
            </dl>
            <p className="mt-2 text-[11px] text-slate-500">{facts.rpoNote} {facts.rtoNote}</p>
          </section>
        </div>

        {/* Runbook */}
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
          <h2 className="eyebrow text-slate-400">Restore runbook</h2>
          <ol className="mt-4 space-y-4">
            {RESTORE_RUNBOOK.map((s) => (
              <li key={s.title} className={`rounded-xl border p-4 ${s.warning ? "border-red-400/25 bg-red-400/[0.05]" : "border-white/[0.07] bg-white/[0.02]"}`}>
                <p className={`text-sm font-bold ${s.warning ? "text-red-300" : "text-slate-200"}`}>{s.title}</p>
                <p className="mt-1 text-xs text-slate-400">{s.detail}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Record a test */}
        <RecordTestForm canRecord={canRecord} methods={RECOVERY_METHODS as unknown as string[]} />

        {/* Test history */}
        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <h2 className="border-b border-white/10 px-5 py-3 eyebrow text-slate-400">Recorded recovery tests</h2>
          {!db ? (
            <p className="px-6 py-8 text-sm text-slate-400">Backend not configured — test history unavailable.</p>
          ) : tests.length === 0 ? (
            <p className="px-6 py-8 text-sm text-slate-400">No recovery tests recorded. Apply migration 0045, then record the first manually-performed restore test.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Tested", "Env", "Method", "Result", "RPO (min)", "RTO (min)", "Notes", "By"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(t.tested_at)}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{t.environment}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{t.method || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${t.result === "passed" ? "bg-lime/15 text-lime ring-lime/30" : t.result === "partial" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>{t.result}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-200">{t.rpo_minutes ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-slate-200">{t.rto_minutes ?? "—"}</td>
                    <td className="max-w-[240px] px-4 py-3 text-slate-400">{t.notes ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{t.actor_id ? `${t.actor_id.slice(0, 8)}…` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="font-mono text-[11px] text-slate-500">
          API: <code className="font-mono">/api/system/recovery</code> · tests POST to <code className="font-mono">/api/system/recovery/tests</code>
        </p>
      </div>
    </SystemGate>
  );
}
