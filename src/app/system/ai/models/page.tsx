export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getModelRegistry } from "@/lib/system/ai-extra";

export const metadata: Metadata = { title: "AI — Models & providers" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  code_default: "code default",
  env_config: "env config",
  agent_registry: "agent registry",
};

export default async function SystemAiModelsPage() {
  const db = serviceClient();
  const m = await getModelRegistry(db);

  return (
    <SystemGate perm="system.ai.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">AI Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Models & providers</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {m.configured ? "live (ai_agents / ai_agent_runs / env presence)" : "backend not configured"} · usage window: 30d
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/ai" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">AI overview →</Link>
            <Link href="/system/integrations" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Integrations →</Link>
          </div>
        </div>

        {/* Providers */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="LLM providers">
            {m.providers.map((p) => (
              <div key={p.name} className="mb-3 last:mb-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-slate-200">{p.name}</span>
                  <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${p.configured ? "bg-lime/15 text-lime ring-lime/30" : "bg-amber-400/15 text-amber-300 ring-amber-400/30"}`}>
                    {p.configured ? "configured" : "not set"}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-slate-500">
                  {p.keyEnv}{p.configured ? " ✓" : " ✗"}{p.modelEnv ? ` · ${p.modelEnv}=${p.model ?? "default"}` : ""}
                </p>
              </div>
            ))}
            <p className="mt-2 text-[11px] text-slate-500">Presence only — secret values are never read. Live provider health checks live under <Link href="/system/integrations" className="text-lime underline">Integrations</Link>.</p>
          </Card>

          {m.openrouter && (
            <Card title="OpenRouter integration">
              <dl className="space-y-1.5 font-mono text-xs">
                <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">status</dt><dd className={`font-bold ${m.openrouter.configured ? "text-lime" : "text-amber-300"}`}>{m.openrouter.configured ? "configured" : "unconfigured"}</dd></div>
                <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">mode</dt><dd className="font-bold text-slate-200">{m.openrouter.mode}</dd></div>
                <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">env vars</dt><dd className="font-bold text-slate-200">{m.openrouter.envVars.join(", ")}</dd></div>
              </dl>
              <p className="mt-3 text-[11px] text-slate-500">Single LLM gateway for assistant, receptionist and eval runs (src/lib/ai/openrouter.ts). No per-provider keys exist in this codebase.</p>
            </Card>
          )}
        </div>

        {/* Model catalog */}
        <Card title={`Model catalog (${m.catalog.length})`} className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Model slug", "Source", "Detail", "Runs 30d", "Cost 30d", "Last run"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {m.catalog.map((c) => {
                  const u = m.usage30d.find((x) => x.slug === c.slug);
                  return (
                    <tr key={c.slug} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-2.5 font-mono font-bold text-slate-200">{c.slug}</td>
                      <td className="px-4 py-2.5"><span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-300 ring-1 ring-white/15">{SOURCE_LABEL[c.source] ?? c.source}</span></td>
                      <td className="max-w-[20rem] px-4 py-2.5 text-[11px] text-slate-400">{c.detail}</td>
                      <td className="px-4 py-2.5 font-mono">{u?.runs ?? 0}</td>
                      <td className="px-4 py-2.5 font-mono">{u ? usd(u.costCents) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(u?.lastRunAt ?? null)}</td>
                    </tr>
                  );
                })}
                {m.catalog.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No models referenced — set OPENROUTER_MODEL or register agents with a model.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">
            Catalog entries are <span className="font-bold text-slate-300">referenced in code/config</span> — availability at the provider is not verified here. Use the OpenRouter health check under Integrations for a live probe.
          </p>
        </Card>

        {/* Usage totals */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Usage totals — last 30 days">
            <dl className="space-y-1.5 font-mono text-xs">
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">agent runs</dt><dd className="font-bold text-slate-200">{m.totals30d.runs}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">errors / denied</dt><dd className="font-bold text-slate-200">{m.totals30d.errors} / {m.totals30d.denied}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">prompt / completion tokens</dt><dd className="font-bold text-slate-200">{m.totals30d.promptTokens.toLocaleString()} / {m.totals30d.completionTokens.toLocaleString()}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">recorded cost</dt><dd className="font-bold text-slate-200">{usd(m.totals30d.costCents)}</dd></div>
            </dl>
            {m.totals30d.runs === 0 && <p className="mt-2 text-[11px] text-slate-500">No runs in ai_agent_runs for this window — usage is instrumented but nothing has executed.</p>}
          </Card>

          <Card title="Per-model usage (30d)">
            {m.usage30d.length === 0 ? (
              <p className="text-sm text-slate-400">No model-attributed runs recorded.</p>
            ) : (
              <table className="w-full text-left font-mono text-xs">
                <thead><tr className="text-[10px] uppercase tracking-wider text-slate-500"><th className="pb-2 pr-3">Model</th><th className="pb-2 pr-3">Runs</th><th className="pb-2 pr-3">Err</th><th className="pb-2 pr-3">Cost</th><th className="pb-2">Last</th></tr></thead>
                <tbody>
                  {m.usage30d.map((u) => (
                    <tr key={u.slug} className="border-t border-white/5">
                      <td className="max-w-[12rem] truncate py-1.5 pr-3 text-slate-300" title={u.slug}>{u.slug}</td>
                      <td className="py-1.5 pr-3">{u.runs}</td>
                      <td className={`py-1.5 pr-3 ${u.errors ? "font-bold text-red-300" : "text-slate-400"}`}>{u.errors}</td>
                      <td className="py-1.5 pr-3">{usd(u.costCents)}</td>
                      <td className="py-1.5 text-[10px] text-slate-500">{when(u.lastRunAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-[11px] text-slate-500">cost_cents is recorded by runAgent callers — agents that don&apos;t report usage show zero cost, not estimated spend.</p>
          </Card>
        </div>
      </div>
    </SystemGate>
  );
}
