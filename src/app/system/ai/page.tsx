export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getAiOverview } from "@/lib/system/ai";
import { AgentControls } from "./AgentControls";

export const metadata: Metadata = { title: "AI — Infrastructure" };

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

export default async function SystemAiPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.ai.manage");
  const o = await getAiOverview(db);

  return (
    <SystemGate perm="system.ai.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">AI Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Agents, models & evals</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {o.configured ? "live (ai_agents / ai_agent_runs / eval_*)" : "backend not configured"}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/admin/evals" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Business eval lab →</Link>
          </div>
        </div>

        {/* Provider / model config — presence only, never values */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="LLM provider">
            {o.providers.map((p) => (
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
            <p className="mt-2 text-[11px] text-slate-500">Secrets are reported as configured/not-configured only — values are never read into this page.</p>
          </Card>

          <Card title="Usage — last 30 days">
            <dl className="space-y-1.5 font-mono text-xs">
              <Row k="agent runs" v={String(o.totals.runs30d)} />
              <Row k="tokens (in/out)" v={`${o.totals.promptTokens30d.toLocaleString()} / ${o.totals.completionTokens30d.toLocaleString()}`} />
              <Row k="cost" v={usd(o.totals.costCents30d)} />
              <Row k="denied by guardrails" v={String(o.totals.denied30d)} />
              <Row k="error rate" v={o.totals.errorRate30d === null ? "—" : `${o.totals.errorRate30d}%`} />
            </dl>
            {o.totals.runs30d === 0 && <p className="mt-2 text-[11px] text-slate-500">No runs recorded — usage is instrumented via ai_agent_runs but nothing has executed in this window.</p>}
          </Card>

          <Card title="Evals & approvals">
            <dl className="space-y-1.5 font-mono text-xs">
              <Row k="eval suites" v={`${o.evals.activeSuites}/${o.evals.suites} active`} />
              <Row k="pending approvals" v={String(o.approvals.pending)} />
              <Row k="agents enabled" v={`${o.totals.enabled}/${o.totals.agents}`} />
            </dl>
            <p className="mt-2 text-[11px] text-slate-500">Eval authoring/running lives in the business portal (<Link href="/admin/evals" className="text-lime underline">/admin/evals</Link>); this view is read-only status.</p>
          </Card>
        </div>

        {/* Agents */}
        <Card title={`Agent registry (${o.agents.length})`} className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Agent", "Dept", "Model", "State", "Runs 30d", "Err %", "Cost 30d", "Last run", "Controls"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {o.agents.map(({ agent: a, stats: s }) => (
                  <tr key={a.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-200">{a.name}</div>
                      <div className="font-mono text-[10px] text-lime">{a.id}</div>
                      {a.description && <div className="mt-0.5 max-w-[16rem] truncate text-[10px] text-slate-500" title={a.description}>{a.description}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{a.department}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-300">{a.model || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${a.enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>
                        {a.enabled ? "enabled" : "disabled"}
                      </span>
                      {!a.enabled && a.config?.kill_reason ? <div className="mt-1 max-w-[10rem] truncate font-mono text-[9px] text-red-300/70" title={String(a.config.kill_reason)}>{String(a.config.kill_reason).slice(0, 60)}</div> : null}
                    </td>
                    <td className="px-4 py-3 font-mono">{s?.runs ?? 0}</td>
                    <td className="px-4 py-3 font-mono">{s ? `${s.errorRate}%` : "—"}</td>
                    <td className="px-4 py-3 font-mono">{s ? usd(s.costCents) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(s?.lastRunAt ?? null)}</td>
                    <td className="px-4 py-3"><AgentControls agentId={a.id} enabled={a.enabled} tools={a.tools} canManage={canManage} /></td>
                  </tr>
                ))}
                {o.agents.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    No agents registered. Seed via <code className="font-mono text-xs">ensureSeedAgents()</code> (admin AI page) or insert rows into <code className="font-mono text-xs">ai_agents</code>.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Guardrail detail */}
        <Card title="Guardrails & budgets">
          <p className="text-sm text-slate-400">
            Every invocation passes <code className="font-mono text-xs">canRun()</code>: enabled flag → hourly call cap →
            daily/monthly cost budgets, enforced in <code className="font-mono text-xs">src/lib/agents/registry.ts</code>.
            Denied runs are recorded, never silently dropped. Human approvals queue in <code className="font-mono text-xs">ai_approvals</code>;
            denied-action classes (refunds, payouts, admin grants…) can never be auto-approved.
          </p>
        </Card>

        {/* Latest eval runs */}
        <Card title="Latest eval runs" className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Suite", "Agent", "Model", "Score", "Passed", "Latency", "When"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {o.evals.latestRuns.map((r, i) => (
                  <tr key={i} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.suite_id.slice(0, 8)}…</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{r.agent_id}</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.model ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono font-bold">{r.score ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono">{r.passed}/{r.total}</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.latency_ms ?? "—"}ms</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(r.created_at)}</td>
                  </tr>
                ))}
                {o.evals.latestRuns.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">No eval runs recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </SystemGate>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-bold text-slate-200">{v}</dd>
    </div>
  );
}
