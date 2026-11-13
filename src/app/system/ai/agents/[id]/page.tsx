export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getAgentOpsDetail } from "@/lib/system/ai-ops";
import { DENIED_ACTIONS } from "@/lib/agents/registry";
import { AgentControls } from "../../AgentControls";

export const metadata: Metadata = { title: "AI — Agent detail" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 py-1.5 last:border-0">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-mono text-xs font-bold text-slate-200">{v}</dd>
    </div>
  );
}

export default async function SystemAgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.ai.manage");
  const detail = db ? await getAgentOpsDetail(db, id) : null;
  if (db && !detail) notFound();

  const a = detail?.agent;
  const s = detail?.stats30d ?? null;
  const today = detail?.today ?? { calls: 0, costCents: 0, denied: 0, lastRunAt: null };

  return (
    <SystemGate perm="system.ai.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">AI Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">
              {a ? a.name : "Agent"} <span className="font-mono text-lg text-lime">{id}</span>
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              {a?.description ?? "Registered agent — read-only registry detail."}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/system/ai" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">← AI overview</Link>
            <Link href="/system/ai/guardrails" className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Guardrails →</Link>
          </div>
        </div>

        {!db ? (
          <Card title="Backend"><p className="text-sm text-slate-400">Backend not configured — agent detail unavailable.</p></Card>
        ) : !a ? null : (
          <>
            {/* Status + controls */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card title="State & controls">
                <div className="flex items-center gap-3">
                  <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ring-1 ${a.enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>
                    {a.enabled ? "enabled" : "disabled"}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">{a.department}</span>
                </div>
                {typeof a.config?.kill_reason === "string" && a.config.kill_reason ? (
                  <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300 ring-1 ring-red-400/20">{String(a.config.kill_reason)}</p>
                ) : null}
                <div className="mt-4">
                  <AgentControls agentId={a.id} enabled={a.enabled} tools={a.tools} canManage={canManage} />
                </div>
                <p className="mt-3 text-[11px] text-slate-500">
                  Controls post to audited <code className="font-mono">/api/system/ai/agents/[id]/*</code> routes (system.ai.manage; breakglass/high-risk → change request).
                </p>
              </Card>

              <Card title="Usage — today (UTC)">
                <dl className="space-y-1.5 font-mono text-xs">
                  <Field k="calls" v={String(today.calls)} />
                  <Field k="denied by guardrails" v={String(today.denied)} />
                  <Field k="recorded cost" v={usd(today.costCents)} />
                  <Field k="last run" v={when(today.lastRunAt)} />
                  <Field k="pending approvals" v={String(detail?.pendingApprovals ?? 0)} />
                </dl>
                <p className="mt-2 text-[11px] text-slate-500">From ai_agent_runs rows since UTC midnight. Agents that don&apos;t report cost show $0.00, not estimates.</p>
              </Card>

              <Card title="Usage — last 30 days">
                {s ? (
                  <dl className="space-y-1.5 font-mono text-xs">
                    <Field k="runs" v={String(s.runs)} />
                    <Field k="ok / errors" v={`${s.ok} / ${s.errors}`} />
                    <Field k="denied / escalated" v={`${s.denied} / ${s.escalated}`} />
                    <Field k="error rate" v={`${s.errorRate}%`} />
                    <Field k="avg duration" v={s.avgDurationMs == null ? "—" : `${s.avgDurationMs}ms`} />
                    <Field k="cost" v={usd(s.costCents)} />
                    <Field k="tokens in/out" v={`${s.promptTokens.toLocaleString()} / ${s.completionTokens.toLocaleString()}`} />
                  </dl>
                ) : (
                  <p className="text-sm text-slate-400">No runs recorded in the last 30 days.</p>
                )}
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* Config */}
              <Card title="Model & runtime config">
                <dl className="font-mono text-xs">
                  <Field k="model" v={a.model || "— (provider default)"} />
                  <Field k="temperature" v={String(a.temperature)} />
                  <Field k="max_tokens" v={String(a.max_tokens)} />
                  <Field k="timeout_ms" v={`${a.timeout_ms}ms`} />
                  <Field k="max_calls/hour" v={String(a.max_calls_per_hour)} />
                  <Field k="daily budget" v={a.daily_budget_cents > 0 ? cents(a.daily_budget_cents) : "uncapped"} />
                  <Field k="monthly budget" v={a.monthly_budget_cents > 0 ? cents(a.monthly_budget_cents) : "uncapped"} />
                  <Field k="escalation policy" v={a.escalation_policy ?? "—"} />
                  <Field k="updated" v={when(a.updated_at)} />
                </dl>
                <p className="mt-3 text-[11px] text-slate-500">
                  Budgets are enforced by <code className="font-mono">canRun()</code> before every invocation — a denied run is recorded, never silently dropped.
                </p>
              </Card>

              {/* Permissions + tools — read-only registry fields */}
              <Card title="Permissions & tools (read-only)">
                <p className="eyebrow text-slate-500">Permissions</p>
                {a.permissions.length === 0 ? (
                  <p className="mt-1 font-mono text-[11px] text-slate-500">none declared</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {a.permissions.map((p) => <span key={p} className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/15">{p}</span>)}
                  </div>
                )}
                <p className="eyebrow mt-4 text-slate-500">Tool allowlist</p>
                {a.tools.length === 0 ? (
                  <p className="mt-1 font-mono text-[11px] text-slate-500">none — no tool access</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {a.tools.map((t) => <span key={t} className="rounded-full bg-sky-400/10 px-2 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-sky-400/20">{t}</span>)}
                  </div>
                )}
                <p className="eyebrow mt-4 text-slate-500">Autonomy notes</p>
                <ul className="mt-1 space-y-1 text-[11px] text-slate-400">
                  <li>· Escalation policy <span className="font-mono text-slate-300">{a.escalation_policy ?? "none"}</span> governs when runs route to humans.</li>
                  <li>· Actions in <code className="font-mono">DENIED_ACTIONS</code> can never be auto-approved through ai_approvals.</li>
                  <li>· Agent permission strings scope business-data access — separate from system console roles.</li>
                </ul>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {DENIED_ACTIONS.map((d) => <span key={d} className="rounded-full bg-red-500/10 px-2 py-0.5 font-mono text-[9px] text-red-300/80 ring-1 ring-red-400/20">{d}</span>)}
                </div>
              </Card>
            </div>

            {/* Recent runs */}
            <Card title="Recent runs" className="!p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-xs">
                  <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>{["Run", "Task", "Status", "Model", "Tokens", "Cost", "Duration", "When"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {(detail?.recentRuns ?? []).map((r) => (
                      <tr key={r.id} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">#{r.id}</td>
                        <td className="max-w-[16rem] truncate px-4 py-2.5 text-slate-300" title={r.task}>{r.task || "—"}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                            r.status === "ok" ? "bg-lime/15 text-lime ring-lime/30"
                            : r.status === "denied" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30"
                            : r.status === "escalated" ? "bg-sky-400/15 text-sky-300 ring-sky-400/30"
                            : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>
                            {r.status}
                          </span>
                          {r.error ? <div className="mt-0.5 max-w-[10rem] truncate font-mono text-[9px] text-red-300/70" title={r.error}>{r.error.slice(0, 60)}</div> : null}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.model ?? "—"}</td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.prompt_tokens ?? 0}/{r.completion_tokens ?? 0}</td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.cost_cents != null ? usd(r.cost_cents) : "—"}</td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(r.created_at)}</td>
                      </tr>
                    ))}
                    {(detail?.recentRuns ?? []).length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No runs recorded for this agent.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </SystemGate>
  );
}
