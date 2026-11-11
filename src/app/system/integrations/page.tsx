export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSystemOverview } from "@/lib/system/overview";
import { listIntegrations } from "@/lib/system/integrations";
import { HealthButtons } from "./HealthButtons";

export const metadata: Metadata = { title: "Integrations" };

const STATUS_TONE: Record<string, string> = {
  operational: "bg-lime/15 text-lime ring-lime/30",
  unconfigured: "bg-white/10 text-slate-300 ring-white/15",
  unknown: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  degraded: "bg-red-500/15 text-red-300 ring-red-400/30",
};

export default async function IntegrationsPage() {
  const db = serviceClient();
  const o = await getSystemOverview(db);
  const integrations = listIntegrations();

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">APIs &amp; Integrations</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Integration registry</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Provider configuration derived from env-var <em>presence</em> only — secret values are never read into
              this page or its API. Live health checks are bounded (5s), read-only, and run on demand; providers
              without an API client in this repo are reported as <span className="font-mono">not_verified</span>.
            </p>
          </div>
          <p className="font-mono text-xs text-slate-400">env: {o.environment} · payments: {o.payments?.overall ?? "unknown"}</p>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.06] font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Purpose</th>
                <th className="px-4 py-3">Env vars</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Last check</th>
                <th className="px-4 py-3 text-right">Health</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((i) => (
                <tr key={i.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <p className="font-bold">{i.name}</p>
                    <p className="font-mono text-[11px] text-slate-500">{i.id} · {i.category}</p>
                  </td>
                  <td className="max-w-[280px] px-4 py-3 text-xs text-slate-400">{i.purpose}</td>
                  <td className="px-4 py-3">
                    {i.envVars.length === 0 ? (
                      <span className="font-mono text-[11px] text-slate-500">none (no runtime client)</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {i.envVars.map((v) => (
                          <span key={v} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${i.configured ? "bg-lime/10 text-lime ring-lime/25" : "bg-white/5 text-slate-500 ring-white/10"}`} title={v}>
                            {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{i.mode}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${STATUS_TONE[i.status] ?? STATUS_TONE.unknown}`}>
                      {i.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">never</td>
                  <td className="px-4 py-3 text-right"><HealthButtons id={i.id} configured={i.configured} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/integrations</code> ·{" "}
          <code className="font-mono">GET /api/system/integrations/{"{id}"}/health</code> — both audited.
        </p>
      </div>
    </SystemGate>
  );
}
