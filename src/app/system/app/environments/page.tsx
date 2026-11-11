export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { getEnvironmentMatrix, type EnvCategory } from "@/lib/system/appinfra";

export const metadata: Metadata = { title: "Environments" };

const catTone: Record<EnvCategory, string> = {
  secret: "bg-red-500/15 text-red-300 ring-red-400/30",
  config: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  public: "bg-lime/15 text-lime ring-lime/30",
  platform: "bg-white/10 text-slate-300 ring-white/15",
};

export default function EnvironmentsPage() {
  const rows = getEnvironmentMatrix();
  const configured = rows.filter((r) => r.configured).length;

  return (
    <SystemGate perm="system.deployments.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">Application / Environments</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Environment variables</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              {rows.length} known variables · {configured} configured (presence only)
            </p>
          </div>
          <Link href="/system/app" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            ← Application
          </Link>
        </div>

        <p className="rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 py-3 text-sm text-slate-300">
          <strong>Names and presence only.</strong> Secret values are never read into this page or its API —{" "}
          <code className="font-mono">configured</code> is a <code className="font-mono">process.env</code> presence check.
          Values are shown solely for the explicit nonsecret allowlist (feature flags / dev switches), labeled as such.
          This read is audit-logged via <code className="font-mono">GET /api/system/app/env</code>.
        </p>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Variable</th>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Configured</th>
                  <th className="py-2 pr-4">Value (nonsecret only)</th>
                  <th className="py-2 pr-4">Scope</th>
                  <th className="py-2">Purpose</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name} className="border-b border-white/5 last:border-0 align-top">
                    <td className="py-2.5 pr-4 font-mono text-xs font-bold text-slate-200">{r.name}</td>
                    <td className="py-2.5 pr-4">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${catTone[r.category]}`}>{r.category}</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                        r.configured ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-500 ring-white/15"
                      }`}>
                        {r.configured ? "set" : "unset"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[11px]">
                      {r.value !== undefined ? (
                        <span className="text-sky-300" title={r.valueNote}>{r.value}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-[10px] text-slate-500">{r.scope}</td>
                    <td className="max-w-[280px] py-2.5 text-xs text-slate-400">{r.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="font-mono text-[11px] text-slate-500">
          API: GET /api/system/app/env (audited) · requires system.deployments.view
        </p>
      </div>
    </SystemGate>
  );
}
