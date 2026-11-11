export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getEvalLab } from "@/lib/system/ai-extra";

export const metadata: Metadata = { title: "AI — Eval laboratory" };

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

export default async function SystemAiEvalsPage() {
  const db = serviceClient();
  const e = await getEvalLab(db);
  const s = e.stats30d;

  // Latest run per suite for the suite table.
  const latestBySuite = new Map<string, (typeof e.runs)[number]>();
  for (const r of e.runs) if (!latestBySuite.has(r.suite_id)) latestBySuite.set(r.suite_id, r);

  return (
    <SystemGate perm="system.ai.view">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow text-lime">AI Infrastructure</p>
            <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Eval laboratory</h1>
            <p className="mt-1 font-mono text-xs text-slate-400">
              data: {e.configured ? "live (eval_suites / eval_runs)" : "backend not configured"} · stats window: 30d · read-only
            </p>
          </div>
          <Link href="/admin/evals" className="rounded-full bg-lime px-4 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8]">Business eval lab →</Link>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Card title="Suites"><p className="font-mono text-3xl font-bold">{e.suites.filter((x) => x.active).length}<span className="text-base text-slate-500">/{e.suites.length}</span></p><p className="mt-1 text-xs text-slate-400">active / total</p></Card>
          <Card title="Runs 30d"><p className="font-mono text-3xl font-bold">{s.runs}</p><p className="mt-1 text-xs text-slate-400">eval_runs rows</p></Card>
          <Card title="Pass rate 30d"><p className={`font-mono text-3xl font-bold ${s.passRatePct !== null && s.passRatePct < 80 ? "text-amber-300" : ""}`}>{s.passRatePct === null ? "—" : `${s.passRatePct}%`}</p><p className="mt-1 text-xs text-slate-400">{s.passed}/{s.total} scenarios</p></Card>
          <Card title="Avg score 30d"><p className="font-mono text-3xl font-bold">{s.avgScore === null ? "—" : s.avgScore}</p><p className="mt-1 text-xs text-slate-400">0–100 composite</p></Card>
          <Card title="Last run"><p className="font-mono text-lg font-bold leading-8">{when(s.lastRunAt)}</p><p className="mt-1 text-xs text-slate-400">any suite</p></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Suites */}
          <Card title={`Suites (${e.suites.length})`} className="!p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Suite", "Agent", "Scenarios", "State", "Latest run"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {e.suites.map((suite) => {
                    const lr = latestBySuite.get(suite.id);
                    return (
                      <tr key={suite.id} className="border-b border-white/5 last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-bold text-slate-200">{suite.name}</div>
                          <div className="font-mono text-[10px] text-slate-500">v{suite.version} · {suite.id.slice(0, 8)}…</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{suite.agent_id ?? "—"}</td>
                        <td className="px-4 py-2.5 font-mono">{suite.scenarioCount}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${suite.active ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{suite.active ? "active" : "inactive"}</span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">
                          {lr ? `${lr.passed}/${lr.total} · score ${lr.score ?? "—"} · ${when(lr.created_at)}` : "no runs"}
                        </td>
                      </tr>
                    );
                  })}
                  {e.suites.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No eval suites — author them in the <Link href="/admin/evals" className="text-lime underline">business eval lab</Link>.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Policy note */}
          <Card title="What evals cover">
            <p className="text-sm text-slate-400">
              Suites contain <span className="font-bold text-slate-200">synthetic scenarios only</span> — never real customer
              conversations. Scored dimensions: accuracy, privacy, authorization, policy, escalation, usefulness.
            </p>
            <ul className="mt-3 space-y-1.5 font-mono text-[11px] text-slate-400">
              <li>· Runs are triggered from the business console (<Link href="/admin/evals" className="text-lime underline">/admin/evals</Link>), not here.</li>
              <li>· This page is read-only status: suites, recent runs, pass/fail rates.</li>
              <li>· <code className="text-slate-300">receptionist_autosend</code> requires a green eval suite before it can be considered — see <Link href="/system/ai/guardrails" className="text-lime underline">guardrails</Link>.</li>
            </ul>
          </Card>
        </div>

        {/* Recent runs */}
        <Card title="Recent eval runs" className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Run", "Suite", "Agent", "Model", "Score", "Passed", "Latency", "Cost", "When"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {e.runs.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">#{r.id}</td>
                    <td className="max-w-[12rem] truncate px-4 py-2.5 text-slate-300" title={r.suite_name ?? r.suite_id}>{r.suite_name ?? `${r.suite_id.slice(0, 8)}…`}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{r.agent_id}</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.model ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono font-bold">{r.score ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono">
                      <span className={r.total > 0 && r.passed === r.total ? "text-lime" : r.passed > 0 ? "text-amber-300" : "text-red-300"}>{r.passed}/{r.total}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.latency_ms ?? "—"}ms</td>
                    <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{r.cost_cents != null ? `$${r.cost_cents.toFixed(4)}` : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(r.created_at)}</td>
                  </tr>
                ))}
                {e.runs.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">No eval runs recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">Showing the 60 most recent runs; 30-day aggregates above cover the full window.</p>
        </Card>
      </div>
    </SystemGate>
  );
}
