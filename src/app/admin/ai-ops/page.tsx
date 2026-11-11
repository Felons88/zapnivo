export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";
import {
  agentStats, ensureSeedAgents, listAgents, listApprovals, listRuns,
  type AgentRow, type AgentStats, type ApprovalRow, type RunRow,
} from "@/lib/agents/registry";
import { AgentDirectory } from "./AgentDirectory";
import { ApprovalQueue } from "./ApprovalQueue";

export const metadata: Metadata = { title: "AI operations", robots: { index: false, follow: false } };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export type DirectoryAgent = AgentRow & { stats: AgentStats | null };

export default async function AiOps() {
  const db = serviceClient();
  if (db) await ensureSeedAgents(db);
  const [agents, stats, runs, approvals] = db
    ? await Promise.all([
        listAgents(db), agentStats(db, 30), listRuns(db, { limit: 60 }), listApprovals(db, "pending", 100),
      ])
    : [[], {}, [], []] as [AgentRow[], Record<string, AgentStats>, RunRow[], ApprovalRow[]];

  const directory: DirectoryAgent[] = agents.map((a) => ({ ...a, stats: stats[a.id] ?? null }));
  const enabled = directory.filter((a) => a.enabled).length;
  const totalRuns = directory.reduce((s, a) => s + (a.stats?.runs ?? 0), 0);
  const totalCost = directory.reduce((s, a) => s + (a.stats?.costCents ?? 0), 0);
  const errorRuns = directory.reduce((s, a) => s + (a.stats?.errors ?? 0), 0);

  return (
    <AdminGate title="AI operations" nav="aiOps">
      {!db ? (
        <EmptyCard title="Agent registry not connected">Connect Supabase to manage the AI agent registry.</EmptyCard>
      ) : (
        <div className="space-y-8">
          <section aria-label="Agent summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Metric label="Agents" value={directory.length} sub={`${enabled} enabled`} />
            <Metric label="Runs (30d)" value={totalRuns} sub={`${runs.length} most recent loaded`} />
            <Metric label="Errors (30d)" value={errorRuns} sub={totalRuns ? `${Math.round((errorRuns / totalRuns) * 1000) / 10}% error rate` : "—"} />
            <Metric label="Spend (30d)" value={`$${totalCost.toFixed(2)}`} sub="recorded cost_cents" />
            <Metric label="Pending approvals" value={approvals.length} sub="awaiting staff decision" />
          </section>

          <section aria-label="Agent directory" className="space-y-4">
            <div>
              <h2 className="font-display text-xl font-bold">Agent directory</h2>
              <p className="mt-1 text-sm text-graphite">Kill switch, budgets and hourly caps are enforced on every run. Manual ping proves gating without calling a model.</p>
            </div>
            <AgentDirectory agents={directory} />
          </section>

          <ApprovalQueue approvals={approvals} />

          <section aria-label="Activity" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Activity log</h2></div>
            {runs.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No agent runs recorded yet.</p>
            ) : (
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["When", "Agent", "Task", "Status", "Duration", "Tokens", "Cost", "Actor", "Error"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                      <td className="px-4 py-3 text-xs text-graphite">{when(r.created_at)}</td>
                      <td className="px-4 py-3 font-semibold">{r.agent_id}</td>
                      <td className="max-w-56 truncate px-4 py-3 text-xs">{r.task}</td>
                      <td className="px-4 py-3"><Pill tone={r.status === "ok" ? "lime" : r.status === "error" ? "red" : r.status === "denied" ? "gold" : "cyan"}>{r.status}</Pill></td>
                      <td className="px-4 py-3 text-xs">{r.duration_ms != null ? `${r.duration_ms}ms` : "—"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{r.prompt_tokens != null || r.completion_tokens != null ? `${r.prompt_tokens ?? 0}/${r.completion_tokens ?? 0}` : "—"}</td>
                      <td className="px-4 py-3 text-xs">{r.cost_cents != null ? `$${Number(r.cost_cents).toFixed(4)}` : "—"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{r.actor ?? "—"}</td>
                      <td className="max-w-48 truncate px-4 py-3 text-xs text-red-800">{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
