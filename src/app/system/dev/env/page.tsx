export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { envDiagnostics } from "@/lib/system/env-diagnostics";

export const metadata: Metadata = { title: "Environment diagnostics" };

/**
 * Presence matrix only — this page NEVER renders env values, only whether a
 * var is set. Use it to answer "why is feature X not working": find the group,
 * see which vars are missing, read the curated feature map.
 */
export default function EnvDiagnosticsPage() {
  const diag = envDiagnostics();

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Developer Tools / Environment</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Environment diagnostics</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Which env vars are <strong className="text-slate-200">set</strong> vs missing, grouped by the
            features they gate. <strong className="text-amber-300">Values are never shown</strong> — only
            presence. NODE_ENV=<code className="font-mono">{diag.nodeEnv}</code>
            {diag.vercelEnv ? <> · VERCEL_ENV=<code className="font-mono">{diag.vercelEnv}</code></> : null}
            {" "}· {diag.missingRequired} required var{diag.missingRequired === 1 ? "" : "s"} missing.
          </p>
        </div>

        {diag.groups.map((g) => (
          <section key={g.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="eyebrow text-slate-400">{g.label}</h2>
              <span className="font-mono text-[11px] text-slate-500">{g.setCount}/{g.vars.length} set</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{g.description}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 font-mono text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Variable</th>
                    <th className="py-2">Gates</th>
                  </tr>
                </thead>
                <tbody>
                  {g.vars.map((v) => (
                    <tr key={v.name} className="border-b border-white/5 last:border-0">
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${v.set ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/10 text-red-300 ring-red-400/20"}`}>
                          {v.set ? "set" : "missing"}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-200">
                        {v.name}
                        {v.secret && <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-slate-400 ring-1 ring-white/10">secret</span>}
                      </td>
                      <td className="py-2 text-xs text-slate-400">{v.features.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <p className="text-xs text-slate-500">
          Vars are read server-side at request time; this page reflects the current deployment&apos;s env.
          To rotate a secret see <Link href="/system/secrets" className="underline hover:text-white">/system/secrets</Link> ·
          live provider checks: <Link href="/system/integrations" className="underline hover:text-white">/system/integrations</Link>.
        </p>
      </div>
    </SystemGate>
  );
}
