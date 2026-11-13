import type { DeploymentPipeline, PipelineStageStatus } from "@/lib/system/deploy-pipeline";

/**
 * Deployment pipeline timeline (Phase 4.1) — server component, no client JS.
 * Renders the derived stage list from derivePipelineStages(): every stage
 * shows its evidence-backed status; 'unknown'/'skipped' stages display their
 * reason so missing evidence is visible, never hidden.
 */

const STAGE_TONE: Record<PipelineStageStatus, string> = {
  done: "bg-lime/15 text-lime ring-lime/30",
  active: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  pending: "bg-white/10 text-slate-300 ring-white/15",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
  skipped: "bg-white/[0.04] text-slate-500 ring-white/10",
  unknown: "bg-amber-400/10 text-amber-300/80 ring-amber-400/20",
};

const OUTCOME_TONE: Record<DeploymentPipeline["outcome"], string> = {
  completed: "bg-lime/15 text-lime ring-lime/30",
  in_progress: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
  canceled: "bg-white/10 text-slate-400 ring-white/15",
  unknown: "bg-amber-400/10 text-amber-300/80 ring-amber-400/20",
};

const DOT: Record<PipelineStageStatus, string> = {
  done: "bg-lime",
  active: "bg-sky-400 animate-pulse",
  pending: "bg-slate-600",
  failed: "bg-red-400",
  skipped: "bg-slate-700",
  unknown: "bg-amber-400/70",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : null;

export function DeploymentPipelineView({ pipeline }: { pipeline: DeploymentPipeline }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="eyebrow text-slate-400">Deployment pipeline</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-bold ring-1 ${OUTCOME_TONE[pipeline.outcome]}`}>
            {pipeline.outcome.replace("_", " ")}
          </span>
          {pipeline.env !== "unknown" && (
            <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[10px] font-bold text-slate-300 ring-1 ring-white/15">
              {pipeline.env}
            </span>
          )}
          {pipeline.action && (
            <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[10px] font-bold text-slate-300 ring-1 ring-white/15">
              {pipeline.action}
            </span>
          )}
        </div>
      </div>

      {/* Evidence summary */}
      <dl className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["commit", pipeline.commitSha ? `${pipeline.commitSha.slice(0, 12)}…` : "—"],
          ["initiator", pipeline.initiator ? `${pipeline.initiator.slice(0, 8)}…` : "—"],
          ["approver", pipeline.approver ? `${pipeline.approver.slice(0, 8)}…` : "—"],
          ["requested", when(pipeline.requestedAt) ?? "—"],
          ["decided", when(pipeline.decidedAt) ?? "—"],
          ["provider deployment", pipeline.providerDeploymentId ? `${pipeline.providerDeploymentId.slice(0, 20)}…` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-0.5">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-mono text-[11px] text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
      {pipeline.providerUrl && (
        <p className="mt-2 font-mono text-[11px] text-slate-500">
          provider: <a href={pipeline.providerUrl} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">{pipeline.providerUrl}</a>
          {pipeline.providerStateRaw ? ` · state ${pipeline.providerStateRaw}` : ""}
        </p>
      )}

      {/* Stage timeline */}
      <ol className="mt-4 space-y-0">
        {pipeline.stages.map((s, i) => {
          const last = i === pipeline.stages.length - 1;
          const ts = when(s.at);
          return (
            <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
              {/* connector */}
              <div className="flex flex-col items-center">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-[#0b0f14] ${DOT[s.status]}`} />
                {!last && <span className={`w-px flex-1 ${s.status === "done" ? "bg-lime/30" : "bg-white/10"}`} />}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-xs font-bold ${s.status === "skipped" ? "text-slate-500" : "text-slate-200"}`}>{s.label}</span>
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ring-1 ${STAGE_TONE[s.status]}`}>
                    {s.status}
                  </span>
                  {ts && <span className="font-mono text-[10px] text-slate-500">{ts}</span>}
                </div>
                {s.reason && (
                  <p className={`mt-0.5 text-[11px] ${s.status === "failed" ? "text-red-300/90" : "text-slate-500"}`}>{s.reason}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 font-mono text-[10px] text-slate-600">
        Derived from recorded evidence only — stages marked unknown/skipped have no supporting data.
      </p>
    </section>
  );
}
