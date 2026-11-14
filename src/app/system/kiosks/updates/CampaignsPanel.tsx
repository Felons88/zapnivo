import type { SupabaseClient } from "@supabase/supabase-js";
import { listCampaignsWithMeta, listApprovedReleases, TARGET_STATES, type TargetState } from "@/lib/system/update-rollouts";
import { CampaignForm } from "./CampaignForm";
import { CampaignActions } from "./CampaignActions";

/**
 * Update campaigns panel — server component. Renders stored campaign state
 * only; all mutations go through /api/system/updates/campaigns. Honest empty
 * states when the backend or approved releases are missing.
 */

const STATUS_TONE: Record<string, string> = {
  draft: "bg-white/10 text-slate-300 ring-white/15",
  pending_approval: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  approved: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  scheduled: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  active: "bg-lime/15 text-lime ring-lime/30",
  paused: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  completed: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
  cancelled: "bg-white/5 text-slate-500 ring-white/10",
  blocked: "bg-red-500/25 text-red-200 ring-red-400/50",
};

const STATE_TONE: Record<string, string> = {
  draft: "text-slate-400", approved: "text-sky-300", scheduled: "text-violet-300",
  queued: "text-amber-300", transferring: "text-amber-300", installing: "text-amber-300",
  reconnecting: "text-cyan-300", verifying: "text-cyan-300", completed: "text-lime",
  failed: "text-red-300", unknown_outcome: "text-red-300", investigating: "text-orange-300",
  recovery: "text-orange-300", cancelled: "text-slate-500",
};

function fmtWindow(w: Record<string, unknown> | null): string {
  if (!w) return "—";
  const s = typeof w.start === "string" ? w.start : null;
  const e = typeof w.end === "string" ? w.end : null;
  if (!s && !e) return "—";
  return `${s ? new Date(s).toLocaleString() : "…"} → ${e ? new Date(e).toLocaleString() : "…"}`;
}

export default async function CampaignsPanel({ db, canManage }: { db: SupabaseClient | null; canManage: boolean }) {
  if (!db) {
    return (
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="eyebrow text-slate-400">Update campaigns</h2>
        <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          Backend not configured — campaign data unavailable.
        </p>
      </section>
    );
  }

  const [campaigns, releases] = await Promise.all([
    listCampaignsWithMeta(db, 100),
    listApprovedReleases(db),
  ]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="eyebrow text-slate-400">Update campaigns</h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            Rollout campaigns over approved releases. Approval requires a different operator than the creator;
            firmware/software campaigns additionally require fresh MFA elevation. Physical dispatch fails closed
            while <code className="font-mono">KIOSK_ADAPTER=none</code> — targets stay honestly queued.
          </p>
        </div>
        {canManage && <CampaignForm releases={releases} />}
      </div>

      {!canManage && (
        <p className="text-xs text-slate-500">Read-only — requires system.kiosks.manage to create or act on campaigns.</p>
      )}

      {campaigns.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-black/20 px-4 py-6 text-center text-sm text-slate-400">
          No update campaigns yet.
          {releases.length === 0 && canManage && (
            <> Approved releases are required first — see the release registry above.</>
          )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3">Campaign</th>
                <th className="py-2 pr-3">Release</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Targets</th>
                <th className="py-2 pr-3">Window</th>
                <th className="py-2 pr-3">Conc.</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(({ campaign: c, release, targetCounts }) => (
                <tr key={c.id} className="border-b border-white/5 align-top">
                  <td className="py-2.5 pr-3">
                    <div className="font-semibold text-slate-200">{c.name}</div>
                    <div className="font-mono text-[10px] text-slate-500">{c.id.slice(0, 8)}</div>
                    {c.pause_reason && <div className="text-[10px] text-orange-300">pause: {c.pause_reason}</div>}
                  </td>
                  <td className="py-2.5 pr-3">
                    {release ? (
                      <>
                        <div className="text-slate-300">{release.kind} <span className="font-mono">{release.version}</span></div>
                        <div className="font-mono text-[10px] text-slate-500">{release.channel}{release.model ? ` · ${release.model}` : ""}</div>
                      </>
                    ) : <span className="text-slate-500">release missing</span>}
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATUS_TONE[c.status] ?? STATUS_TONE.draft}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
                      {TARGET_STATES.filter((s) => (targetCounts[s as TargetState] ?? 0) > 0).map((s) => (
                        <span key={s} className={STATE_TONE[s]}>{s}:{targetCounts[s as TargetState]}</span>
                      ))}
                      {Object.keys(targetCounts).length === 0 && <span className="text-slate-600">none</span>}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-[10px] text-slate-400">{fmtWindow(c.maintenance_window as Record<string, unknown> | null)}</td>
                  <td className="py-2.5 pr-3 font-mono text-[10px] text-slate-300">{c.concurrency_limit}</td>
                  <td className="py-2.5 pr-3 text-[10px] text-slate-400">
                    {new Date(c.created_at).toLocaleDateString()}
                    {c.approved_by && <div className="font-mono text-slate-500">appr: {c.approved_by.slice(0, 8)}</div>}
                  </td>
                  <td className="py-2.5">
                    <CampaignActions campaignId={c.id} status={c.status} canManage={canManage} needsElevation={release ? ["firmware", "software"].includes(release.kind) : false} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
