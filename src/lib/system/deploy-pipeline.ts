import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEPLOY_ACTIONS,
  DEPLOY_TARGET_ENVS,
  getDeploymentRequest,
  type DeploymentRequestRow,
} from "./deployops";
import { getVercelDeployment, vercelConfigured } from "./deploy-provider";
import { vercelEnv, vercelState, type DeploymentState } from "./deploy-center";

/**
 * Deployment pipeline stage model (Phase 4.1).
 *
 * derivePipelineStages() is a PURE function: it maps whatever evidence exists
 * (the system_deployment_requests row, stored provider-monitor state, the
 * post-deploy HTTP health result, and the app health-profile verdict) onto a
 * fixed stage list. It never invents progress — a stage with no evidence is
 * 'unknown' (or 'skipped' with a reason when the stage genuinely does not
 * apply, e.g. preview stages for a production deploy).
 *
 * Stage order mirrors the real flow:
 *   requested → source_validated → checks_passed → preview_building →
 *   preview_ready → review_pending → approved → production_deploying →
 *   production_ready → health_verified → completed
 *
 * 'executed' on a request means the provider ACCEPTED the deployment — it is
 * NOT proof the deploy is live. Only result.health.status === 'healthy' (or a
 * healthy app health profile) verifies health.
 */

export const PIPELINE_STAGE_IDS = [
  "requested",
  "source_validated",
  "checks_passed",
  "preview_building",
  "preview_ready",
  "review_pending",
  "approved",
  "production_deploying",
  "production_ready",
  "health_verified",
  "completed",
] as const;
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

export type PipelineStageStatus = "done" | "active" | "pending" | "failed" | "skipped" | "unknown";

export type PipelineStage = {
  id: PipelineStageId;
  label: string;
  status: PipelineStageStatus;
  /** ISO timestamp of the evidence, when known. */
  at: string | null;
  /** Why the stage is skipped/unknown/failed — honest explanation, never blank. */
  reason: string | null;
};

export type PipelineOutcome = "in_progress" | "completed" | "failed" | "canceled" | "unknown";

/** Provider-side evidence snapshot (live read or stored monitor state). */
export type PipelineProviderInput = {
  deploymentId: string | null;
  url: string | null;
  /** Mapped DeploymentState (ready/building/queued/error/canceled/…). */
  state: DeploymentState | null;
  stateRaw: string | null;
  commitSha: string | null;
  checkedAt: string | null;
};

/** Stored post-deploy HTTP probe (request.result.health). */
export type PipelineHealthInput = {
  status: string | null;
  checkedAt: string | null;
  httpStatus: number | null;
};

/** Stored app health-profile verdict (request.result.healthProfile). */
export type PipelineProfileInput = {
  status: string | null;
  ranAt: string | null;
  criticalFailures: number;
};

export type PipelineInput = {
  /** The approval request row, or null for provider-only deployments. */
  request: DeploymentRequestRow | null;
  /** Target env override for provider-only records ("production"|"preview"|…). */
  env?: string;
  provider?: PipelineProviderInput | null;
  health?: PipelineHealthInput | null;
  healthProfile?: PipelineProfileInput | null;
};

export type DeploymentPipeline = {
  stages: PipelineStage[];
  outcome: PipelineOutcome;
  env: string;
  action: string | null;
  commitSha: string | null;
  initiator: string | null;
  approver: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  providerDeploymentId: string | null;
  providerUrl: string | null;
  providerState: DeploymentState | null;
  providerStateRaw: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

const STAGE_LABELS: Record<PipelineStageId, string> = {
  requested: "Requested",
  source_validated: "Source validated",
  checks_passed: "Checks passed",
  preview_building: "Preview building",
  preview_ready: "Preview ready",
  review_pending: "Review pending",
  approved: "Approved",
  production_deploying: "Production deploying",
  production_ready: "Production ready",
  health_verified: "Health verified",
  completed: "Completed",
};

const BUILDING: ReadonlySet<string> = new Set(["queued", "building"]);
const FAILED_PROVIDER: ReadonlySet<string> = new Set(["error", "canceled"]);

function stage(id: PipelineStageId, status: PipelineStageStatus, at: string | null = null, reason: string | null = null): PipelineStage {
  return { id, label: STAGE_LABELS[id], status, at, reason };
}

/**
 * Maps recorded evidence onto the fixed pipeline. Pure — no I/O, no clock
 * reads (all timestamps come from the input rows).
 */
export function derivePipelineStages(input: PipelineInput): DeploymentPipeline {
  const req = input.request;
  const provider = input.provider ?? null;
  const health = input.health ?? null;
  const profile = input.healthProfile ?? null;

  const meta = (req?.result && typeof req.result === "object" ? req.result : {}) as Record<string, unknown>;
  const action = req?.action ?? null;
  const env = (input.env ?? req?.target_env ?? "unknown").slice(0, 40);
  const isPreview = env === "preview";
  const isProduction = env === "production";

  const ref = str(meta.ref);
  const targetDeploymentId = str(meta.target_deployment_id);
  const executedAt = str(meta.executed_at);
  const providerDeploymentId = str(meta.provider_deployment_id) ?? provider?.deploymentId ?? null;
  const providerUrl = str(meta.provider_url) ?? provider?.url ?? null;
  const pState = provider?.state ?? null;

  const stages: PipelineStage[] = [];

  /* ── requested ─────────────────────────────────────────────────────── */
  if (req) {
    stages.push(stage("requested", "done", req.created_at));
  } else if (provider) {
    stages.push(stage("requested", "skipped", null, "provider deployment is not linked to an approval request"));
  } else {
    stages.push(stage("requested", "unknown", null, "no request or provider evidence"));
  }

  /* ── source_validated ──────────────────────────────────────────────── */
  if (!req) {
    stages.push(stage("source_validated", "unknown", null, "no request metadata to validate"));
  } else if (action === "deploy") {
    stages.push(ref
      ? stage("source_validated", "done", req.created_at, `ref '${ref.slice(0, 80)}' recorded (allowlist enforced at request + execute)`)
      : stage("source_validated", "unknown", null, "deploy request has no recorded ref"));
  } else if (action === "rollback" || action === "promote") {
    stages.push(targetDeploymentId
      ? stage("source_validated", "done", req.created_at, `target deployment ${targetDeploymentId.slice(0, 24)} recorded`)
      : stage("source_validated", "unknown", null, `${action} request has no recorded target deployment`));
  } else {
    stages.push(stage("source_validated", "unknown", null, `unrecognized action '${action ?? "none"}'`));
  }

  /* ── checks_passed ─────────────────────────────────────────────────── */
  if (!req) {
    stages.push(stage("checks_passed", "unknown", null, "no request row to check"));
  } else {
    const problems: string[] = [];
    if (!(DEPLOY_ACTIONS as readonly string[]).includes(req.action)) problems.push(`unknown action '${req.action}'`);
    if (!(DEPLOY_TARGET_ENVS as readonly string[]).includes(req.target_env)) problems.push(`unknown target_env '${req.target_env}'`);
    if (req.justification.trim().length < 10) problems.push("justification missing/too short");
    stages.push(problems.length === 0
      ? stage("checks_passed", "done", req.created_at)
      : stage("checks_passed", "failed", req.created_at, problems.join("; ")));
  }

  /* ── preview stages (only when target_env === 'preview') ───────────── */
  const previewFallback = (): { building: PipelineStageStatus; ready: PipelineStageStatus; at: string | null; reason: string | null } => {
    // No provider state — fall back to request status honestly.
    if (!req) return { building: "unknown", ready: "unknown", at: null, reason: "no provider or request evidence" };
    if (req.status === "rejected") return { building: "skipped", ready: "skipped", at: req.decided_at, reason: "request rejected before deploy" };
    if (req.status === "failed") return { building: "failed", ready: "skipped", at: null, reason: "request marked failed" };
    if (req.status === "executed") return { building: "unknown", ready: "unknown", at: executedAt, reason: "executed without provider state — manual deploy outcome unverified" };
    return { building: "pending", ready: "pending", at: null, reason: "awaiting execution" };
  };

  if (!isPreview) {
    stages.push(stage("preview_building", "skipped", null, `target env '${env}' — no preview stage`));
    stages.push(stage("preview_ready", "skipped", null, `target env '${env}' — no preview stage`));
  } else {
    const fb = previewFallback();
    let bStatus: PipelineStageStatus = fb.building;
    let rStatus: PipelineStageStatus = fb.ready;
    let at: string | null = fb.at;
    let reason: string | null = fb.reason;
    if (pState && BUILDING.has(pState)) { bStatus = "active"; rStatus = "pending"; at = provider?.checkedAt ?? null; reason = `provider state '${pState}'`; }
    else if (pState === "ready") { bStatus = "done"; rStatus = "done"; at = provider?.checkedAt ?? null; reason = null; }
    else if (pState && FAILED_PROVIDER.has(pState)) { bStatus = "failed"; rStatus = "failed"; at = provider?.checkedAt ?? null; reason = `provider state '${pState}'`; }
    stages.push(stage("preview_building", bStatus, at, reason));
    stages.push(stage("preview_ready", rStatus, at, pState === "ready" ? null : reason));
  }

  /* ── review_pending / approved ─────────────────────────────────────── */
  if (!req) {
    stages.push(stage("review_pending", "unknown", null, "no approval request"));
    stages.push(stage("approved", "unknown", null, "no approval request"));
  } else if (req.status === "pending") {
    stages.push(stage("review_pending", "active", req.created_at, "awaiting a decision"));
    stages.push(stage("approved", "pending", null, "review not decided"));
  } else {
    const decidedAt = req.decided_at ?? req.created_at;
    stages.push(stage("review_pending", "done", decidedAt, req.status === "rejected" ? "rejected" : null));
    if (req.status === "rejected") {
      stages.push(stage("approved", "failed", decidedAt, "request rejected"));
    } else {
      stages.push(stage("approved", "done", decidedAt));
    }
  }

  /* ── production stages (only when target_env === 'production') ─────── */
  const prodFallback = () => {
    if (!req) return { dep: "unknown" as PipelineStageStatus, ready: "unknown" as PipelineStageStatus, at: null as string | null, reason: "no provider or request evidence" };
    if (req.status === "rejected") return { dep: "skipped" as PipelineStageStatus, ready: "skipped" as PipelineStageStatus, at: req.decided_at, reason: "request rejected before deploy" };
    if (req.status === "failed") return { dep: "failed" as PipelineStageStatus, ready: "skipped" as PipelineStageStatus, at: null, reason: "request marked failed" };
    if (req.status === "executed") {
      // Provider accepted, but with no live/stored provider state we cannot
      // claim the deploy is live — ready stays unknown, not done.
      return { dep: "done" as PipelineStageStatus, ready: "unknown" as PipelineStageStatus, at: executedAt ?? req.created_at, reason: "provider accepted; live state unverified" };
    }
    return { dep: "pending" as PipelineStageStatus, ready: "pending" as PipelineStageStatus, at: null, reason: req.status === "approved" ? "approved — awaiting execution (manual deploy when provider unconfigured)" : "awaiting approval + execution" };
  };

  if (!isProduction) {
    stages.push(stage("production_deploying", "skipped", null, `target env '${env}' — no production stage`));
    stages.push(stage("production_ready", "skipped", null, `target env '${env}' — no production stage`));
  } else {
    const fb = prodFallback();
    let depStatus: PipelineStageStatus = fb.dep;
    let readyStatus: PipelineStageStatus = fb.ready;
    let at: string | null = fb.at;
    let reason: string | null = fb.reason;
    if (pState && BUILDING.has(pState)) {
      depStatus = "active"; readyStatus = "pending"; at = provider?.checkedAt ?? null; reason = `provider state '${pState}'`;
    } else if (pState === "ready") {
      depStatus = "done"; readyStatus = "done"; at = provider?.checkedAt ?? null; reason = null;
    } else if (pState === "error" || pState === "canceled") {
      depStatus = "failed"; readyStatus = "failed"; at = provider?.checkedAt ?? null; reason = `provider state '${pState}'`;
    }
    stages.push(stage("production_deploying", depStatus, at, reason));
    stages.push(stage("production_ready", readyStatus, at, pState === "ready" ? null : reason));
  }

  /* ── health_verified ───────────────────────────────────────────────── */
  const profileBad = profile?.status === "degraded" || profile?.status === "unreachable";
  if (health?.status === "healthy" || (!health || health.status === "skipped" || health.status === "unknown") && profile?.status === "healthy") {
    stages.push(stage("health_verified", "done",
      health?.status === "healthy" ? health.checkedAt : (profile?.ranAt ?? null),
      health?.status === "healthy" ? null : "app health profile healthy (no per-deploy probe recorded)"));
  } else if (health?.status === "unhealthy") {
    stages.push(stage("health_verified", "failed", health.checkedAt, `post-deploy probe unhealthy (HTTP ${health.httpStatus ?? "none"})`));
  } else if (profileBad) {
    stages.push(stage("health_verified", "failed", profile?.ranAt ?? null, `app health profile '${profile?.status}'${profile && profile.criticalFailures > 0 ? ` — ${profile.criticalFailures} critical check(s) failed` : ""}`));
  } else if (health || profile) {
    stages.push(stage("health_verified", "pending", null, "health evidence recorded but not conclusive"));
  } else {
    stages.push(stage("health_verified", "unknown", null, "no health probe or profile result recorded"));
  }

  /* ── completed ─────────────────────────────────────────────────────── */
  const canceled = req?.status === "rejected" || pState === "canceled";
  const failed = req?.status === "failed" || pState === "error"
    || health?.status === "unhealthy" || profileBad
    || stages.some((s) => s.status === "failed");
  const hv = stages.find((s) => s.id === "health_verified");
  if (canceled) {
    stages.push(stage("completed", "skipped", req?.decided_at ?? provider?.checkedAt ?? null, "deployment canceled/rejected — never completed"));
  } else if (failed) {
    stages.push(stage("completed", "skipped", null, "pipeline did not complete successfully"));
  } else if (hv?.status === "done") {
    stages.push(stage("completed", "done", health?.checkedAt ?? profile?.ranAt ?? null));
  } else {
    const anyActive = stages.some((s) => s.status === "active" || s.status === "pending");
    const anyUnknown = stages.some((s) => s.status === "unknown");
    stages.push(stage("completed",
      anyActive ? "pending" : anyUnknown ? "unknown" : "pending",
      null,
      anyActive ? "pipeline still in progress" : anyUnknown ? "earlier stages lack evidence" : "awaiting health verification"));
  }

  /* ── outcome ───────────────────────────────────────────────────────── */
  const outcome: PipelineOutcome = canceled ? "canceled"
    : failed ? "failed"
    : stages.find((s) => s.id === "completed")?.status === "done" ? "completed"
    : stages.some((s) => s.status === "active" || s.status === "pending") ? "in_progress"
    : "unknown";

  return {
    stages,
    outcome,
    env,
    action,
    commitSha: provider?.commitSha ?? null,
    initiator: req?.requested_by ?? null,
    approver: req?.decided_by ?? null,
    requestedAt: req?.created_at ?? provider?.checkedAt ?? null,
    decidedAt: req?.decided_at ?? null,
    executedAt,
    providerDeploymentId,
    providerUrl,
    providerState: pState,
    providerStateRaw: provider?.stateRaw ?? null,
  };
}

/* ── Loader (I/O — kept out of the pure function) ─────────────────────── */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function healthFromMeta(meta: Record<string, unknown>): PipelineHealthInput | null {
  const h = asRecord(meta.health);
  if (!Object.keys(h).length) return null;
  return {
    status: str(h.status),
    checkedAt: str(h.checkedAt),
    httpStatus: typeof h.httpStatus === "number" ? h.httpStatus : null,
  };
}

function profileFromMeta(meta: Record<string, unknown>): PipelineProfileInput | null {
  const p = asRecord(meta.healthProfile);
  if (!Object.keys(p).length) return null;
  return {
    status: str(p.status),
    ranAt: str(p.ranAt),
    criticalFailures: Array.isArray(p.criticalFailures) ? p.criticalFailures.length : 0,
  };
}

/**
 * Loads evidence and derives the pipeline for one deployment detail id.
 * `id` may be a request UUID or a Vercel deployment uid. Provider reads are
 * live but read-only (single GET) and only when Vercel is configured; stored
 * result.provider_monitor / result.health / result.healthProfile on the
 * request row are the fallback when the provider can't be reached.
 * Returns null when neither a request nor a provider deployment resolves.
 */
export async function getDeploymentPipeline(
  db: SupabaseClient | null,
  id: string,
): Promise<DeploymentPipeline | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  const isProviderId = /^[A-Za-z0-9_-]{4,100}$/.test(id);

  let request: DeploymentRequestRow | null = null;
  if (isUuid && db) {
    const { request: req } = await getDeploymentRequest(db, id);
    request = req;
  }

  const meta = asRecord(request?.result);
  const storedMonitor = asRecord(meta.provider_monitor);
  const storedProviderId = str(meta.provider_deployment_id);

  // Resolve provider evidence: live read first (fresh, read-only), then the
  // stored monitor snapshot, then nothing.
  let provider: PipelineProviderInput | null = null;
  let providerEnv: string | undefined;
  const pid = storedProviderId ?? (!isUuid && isProviderId ? id : null);
  if (pid && vercelConfigured()) {
    const dep = await getVercelDeployment(pid);
    if (dep.configured && dep.ok) {
      providerEnv = vercelEnv(dep.data.target, dep.data.commitRef);
      provider = {
        deploymentId: dep.data.uid,
        url: dep.data.url ? `https://${dep.data.url}` : null,
        state: vercelState(dep.data.readyState, dep.data.target),
        stateRaw: dep.data.readyState,
        commitSha: dep.data.commitSha,
        checkedAt: new Date().toISOString(),
      };
    }
  }
  if (!provider && storedMonitor.state) {
    provider = {
      deploymentId: storedProviderId,
      url: str(meta.provider_url),
      state: (storedMonitor.state as DeploymentState) ?? null,
      stateRaw: str(storedMonitor.raw),
      commitSha: null,
      checkedAt: str(storedMonitor.checked_at),
    };
  }
  if (!provider && !isUuid && isProviderId && !vercelConfigured()) {
    return null; // provider uid but provider unconfigured and no request — nothing to show
  }
  if (!provider && !request) return null;

  // Provider-only record (Vercel uid page, no request row).
  const env = request?.target_env ?? providerEnv ?? str(meta.target_env) ?? undefined;

  return derivePipelineStages({
    request,
    env,
    provider,
    health: request ? healthFromMeta(meta) : null,
    healthProfile: request ? profileFromMeta(meta) : null,
  });
}
