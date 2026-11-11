export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getGuardrailsView } from "@/lib/system/ai-extra";
import { AGENT_APPROVAL_LIMIT_CENTS } from "@/lib/helpdesk/refund-policy";

export const metadata: Metadata = { title: "AI — Guardrails & permissions" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const cents = (c: number) => `$${(c / 100).toFixed(2)}`;

export default async function SystemAiGuardrailsPage() {
  const db = serviceClient();
  const g = await getGuardrailsView(db);

  return (
    <SystemGate perm="system.ai.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">AI Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Guardrails & tool permissions</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {g.configured ? "live (ai_agents / system_feature_flags / ai_approvals)" : "backend not configured"} · read-only
            </p>
          </div>
          <Link href="/system/ai" className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">Agent controls →</Link>
        </div>

        {/* Policy summary */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card title="Approval boundary">
            <p className="text-sm text-slate-400">
              Every agent invocation passes <code className="font-mono text-xs">canRun()</code> (enabled → hourly cap → daily/monthly budgets)
              and sensitive actions route through <code className="font-mono text-xs">ai_approvals</code>.
              Currently <span className="font-bold text-slate-200">{g.pendingApprovals} approval(s)</span> pending.
            </p>
          </Card>
          <Card title="Never auto-approved">
            <p className="text-sm text-slate-400">
              Actions in <code className="font-mono text-xs">DENIED_ACTIONS</code> can never be approved through the approvals module —
              they stay pending for a human workflow outside it.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {g.deniedActions.map((a) => (
                <span key={a} className="rounded-full bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-red-300 ring-1 ring-red-400/30">{a}</span>
              ))}
            </div>
          </Card>
          <Card title="Refunds specifically">
            <p className="text-sm text-slate-400">
              The AI may <span className="font-bold text-slate-200">draft</span> refund explanations but can never issue or approve refunds —
              enforced by <code className="font-mono text-xs">refund.issue</code> in DENIED_ACTIONS and the helpdesk refund policy
              (<code className="font-mono text-xs">src/lib/helpdesk/refund-policy.ts</code>: agent limit {cents(AGENT_APPROVAL_LIMIT_CENTS)}, second-person rule, balance tracking).
            </p>
          </Card>
        </div>

        {/* Agents × tools/permissions */}
        <Card title={`Agent tool permissions (${g.agents.length})`} className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Agent", "Dept", "State", "Tools allowlist", "Permissions", "Budgets", "Escalation"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {g.agents.map((a) => (
                  <tr key={a.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-200">{a.name}</div>
                      <div className="font-mono text-[10px] text-lime">{a.id}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-slate-500">{a.model || "no model"}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{a.department}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${a.enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-red-500/15 text-red-300 ring-red-400/30"}`}>
                        {a.enabled ? "enabled" : "disabled"}
                      </span>
                      {!a.enabled && a.killReason ? <div className="mt-1 max-w-[10rem] truncate font-mono text-[9px] text-red-300/70" title={a.killReason}>{a.killReason.slice(0, 60)}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {a.tools.length === 0 ? (
                        <span className="font-mono text-[10px] text-slate-500">none — no tool access</span>
                      ) : (
                        <div className="flex max-w-[14rem] flex-wrap gap-1">
                          {a.tools.map((t) => <span key={t} className="rounded-full bg-sky-400/10 px-2 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-sky-400/20">{t}</span>)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {a.permissions.length === 0 ? <span className="font-mono text-[10px] text-slate-500">—</span> : (
                        <div className="flex max-w-[14rem] flex-wrap gap-1">
                          {a.permissions.map((p) => <span key={p} className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/15">{p}</span>)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">
                      {cents(a.budgets.dailyCents)}/day · {cents(a.budgets.monthlyCents)}/mo · {a.budgets.maxCallsPerHour}/hr
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400">{a.escalationPolicy ?? "—"}</td>
                  </tr>
                ))}
                {g.agents.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No agents registered.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">
            Edit tools/kill-switch on the <Link href="/system/ai" className="text-lime underline">AI overview</Link> (requires system.ai.manage).
            The <code className="font-mono">tools</code> column is a slug allowlist validated by <code className="font-mono">updateAgent()</code>.
          </p>
        </Card>

        {/* AI feature flags */}
        <Card title="AI feature flags" className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Flag", "Enabled", "Description", "Prerequisites", "Updated"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {g.flags.map((f) => (
                  <tr key={f.key} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 font-mono font-bold text-slate-200">{f.key}<div className="font-mono text-[9px] font-normal text-slate-500">{f.environment}</div></td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${f.enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{f.enabled ? "on" : "off"}</span>
                    </td>
                    <td className="max-w-[24rem] px-4 py-2.5 text-[11px] text-slate-400">{f.description}</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">
                      {Array.isArray(f.prerequisites) ? (f.prerequisites as unknown[]).filter((x): x is string => typeof x === "string").join(" · ") || "—" : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(f.updated_at)}</td>
                  </tr>
                ))}
                {g.flags.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No AI-owned flags in system_feature_flags.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">
            Flag rows are control-plane metadata + audit trail — runtime behavior is still governed by env vars and code paths.
            Manage under <Link href="/system/settings/flags" className="text-lime underline">Settings → Flags</Link> (system.flags.manage).
          </p>
        </Card>

        {/* Permission model */}
        <Card title="Permission model">
          <p className="text-sm text-slate-400">
            Agents declare scoped permission strings (e.g. <code className="font-mono text-xs">support.customer.read_own</code>,{" "}
            <code className="font-mono text-xs">fleet.telemetry.read</code>) that map to business-data access — separate from this
            console&apos;s system roles. System-side control requires <code className="font-mono text-xs">system.ai.view</code> to read and{" "}
            <code className="font-mono text-xs">system.ai.manage</code> to mutate (kill-switch, tool allowlists, budgets). Denied runs are
            recorded in <code className="font-mono text-xs">ai_agent_runs</code> with status <code className="font-mono text-xs">denied</code> — never silently dropped.
          </p>
        </Card>
      </div>
    </SystemGate>
  );
}
