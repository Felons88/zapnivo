import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, assertApprovedOrRequest, type SystemActor } from "./audit";
import { requireElevation } from "./elevation";
import {
  createDeploymentRequest,
  executeDeploymentRequest,
  getDeploymentRequest,
  listDeploymentRequests,
  type DeploymentRequestRow,
} from "./deployops";
import {
  allowedDeployRefs,
  createVercelDeployment,
  githubGate,
  getVercelDeployment,
  getVercelDeploymentEvents,
  isAllowedDeployRef,
  listVercelDeployments,
  promoteVercelDeployment,
  vercelGate,
  vercelConfigured,
  type VercelDeployment,
  type VercelDeploymentEvent,
} from "./deploy-provider";
import { MIGRATIONS } from "./database";
import {
  runAndRecordHealthProfile,
  type HealthProfileResult,
} from "./deploy-health";

/**
 * Deployment center — merges provider-live data (Vercel API when configured)
 * with the approval-gated system_deployment_requests workflow.
 *
 * Honesty rules:
 *  - No provider token → provider sections return configured:false and the UI
 *    falls back to the manual request→approve→awaiting_manual_deploy flow.
 *  - Deployment URLs are probed ONLY when they are https://*.vercel.app (or an
 *    explicit DEPLOY_PROBE_DOMAINS allowlist entry) — never arbitrary URLs.
 *  - Provider tokens never appear in responses, errors, or audit detail.
 */

export type DeploymentSource = "vercel_api" | "approval_request" | "manual_record";
export type DeploymentState =
  | "queued" | "building" | "ready" | "error" | "canceled"
  | "pending" | "awaiting_manual" | "unknown";

export type DeploymentRecord = {
  /** Provider deployment uid for vercel_api rows; request id for approval_request rows. */
  id: string;
  source: DeploymentSource;
  env: string; // production | preview | development | unknown
  commitSha: string | null;
  branch: string | null;
  state: DeploymentState;
  stateRaw: string | null;
  createdAt: string | null;
  url: string | null;
  inspectorUrl: string | null;
  /** Present on approval_request rows: the underlying request id + status. */
  requestId: string | null;
  requestStatus: string | null;
  reachable: boolean | null;
  /** GitHub commit URL when GITHUB_REPO is configured and sha is valid. */
  commitUrl: string | null;
};

/* ── State/env mapping ─────────────────────────────────────────────────── */

export function vercelState(readyState: string | null, target: string | null): DeploymentState {
  switch ((readyState ?? "").toUpperCase()) {
    case "READY": return "ready";
    case "ERROR": return "error";
    case "CANCELED": return "canceled";
    case "QUEUED": return "queued";
    case "BUILDING":
    case "INITIALIZING":
    case "UPLOADING": return "building";
    default: return "unknown";
  }
}

export function vercelEnv(target: string | null, commitRef: string | null): string {
  if (target === "production") return "production";
  if (target === "staging") return "preview";
  // Vercel omits target on preview builds; treat null as preview unless the
  // commit ref is the deploy-allowed production ref — we can't know for sure,
  // so report 'preview' honestly (target null ≠ production alias).
  return "preview";
}

const REQUEST_STATE: Record<string, DeploymentState> = {
  pending: "pending",
  approved: "awaiting_manual",
  rejected: "canceled",
  executed: "ready",
  failed: "error",
};

function deploymentRecordFromVercel(d: VercelDeployment): DeploymentRecord {
  return {
    id: d.uid,
    source: "vercel_api",
    env: vercelEnv(d.target, d.commitRef),
    commitSha: d.commitSha,
    branch: d.commitRef,
    state: vercelState(d.readyState, d.target),
    stateRaw: d.readyState,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
    url: d.url ? `https://${d.url}` : null,
    inspectorUrl: d.inspectorUrl,
    requestId: null,
    requestStatus: null,
    reachable: null,
    commitUrl: githubCommitUrl(d.commitSha),
  };
}

function deploymentRecordFromRequest(r: DeploymentRequestRow): DeploymentRecord {
  return {
    id: `req:${r.id}`,
    source: "approval_request",
    env: r.target_env || "unknown",
    commitSha: null,
    branch: null,
    state: REQUEST_STATE[r.status] ?? "unknown",
    stateRaw: r.status,
    createdAt: r.created_at,
    url: null,
    inspectorUrl: null,
    requestId: r.id,
    requestStatus: r.status,
    reachable: null,
    commitUrl: null,
  };
}

/* ── URL probe allowlist ───────────────────────────────────────────────── */

/**
 * Only https URLs on *.vercel.app or explicitly allowlisted probe domains are
 * ever HEAD-probed. Returns the normalized URL or null.
 */
export function probeableUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".vercel.app") || host === "vercel.app") return u.toString();
  const extra = (process.env.DEPLOY_PROBE_DOMAINS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(host)) return u.toString();
  return null;
}

/** Bounded HEAD probe — reachable:true/false, null when not probeable. */
export async function probeDeploymentUrl(url: string | null, timeoutMs = 3500): Promise<boolean | null> {
  const target = probeableUrl(url);
  if (!target) return null;
  try {
    const res = await fetch(target, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/* ── Aggregation ───────────────────────────────────────────────────────── */

export type DeploymentListResult = {
  deployments: DeploymentRecord[];
  providers: { vercel: { configured: boolean; missing: string[] }; github: { configured: boolean; missing: string[] } };
  vercelError: string | null;
  requestsError: string | null;
};

/**
 * Merges live Vercel deployments (when configured) with approval-request
 * records. Provider failure degrades honestly — requests still list.
 */
export async function listDeployments(db: SupabaseClient | null, opts: { probe?: boolean; limit?: number } = {}): Promise<DeploymentListResult> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const vg = vercelGate();
  const gg = githubGate();
  const out: DeploymentListResult = {
    deployments: [],
    providers: {
      vercel: { configured: vg.configured, missing: vg.missing },
      github: { configured: gg.configured, missing: gg.missing },
    },
    vercelError: null,
    requestsError: null,
  };

  if (vg.configured) {
    const res = await listVercelDeployments(Math.min(limit, 50));
    if (res.configured && res.ok) {
      out.deployments.push(...res.data.map(deploymentRecordFromVercel));
    } else if (res.configured) {
      out.vercelError = res.error;
    }
  }

  if (db) {
    const { requests, error } = await listDeploymentRequests(db, limit);
    out.requestsError = error;
    out.deployments.push(...requests.map(deploymentRecordFromRequest));
  }

  out.deployments.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  out.deployments = out.deployments.slice(0, limit);

  if (opts.probe) {
    const targets = out.deployments.filter((d) => d.source === "vercel_api" && d.url).slice(0, 15);
    await Promise.all(targets.map(async (d) => {
      d.reachable = await probeDeploymentUrl(d.url);
    }));
  }
  return out;
}

/* ── GitHub commit links ───────────────────────────────────────────────── */

export function githubCommitUrl(commitSha: string | null): string | null {
  if (!commitSha || !/^[0-9a-f]{7,64}$/i.test(commitSha)) return null;
  const repo = process.env.GITHUB_REPO?.trim();
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(repo ?? "");
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/commit/${commitSha}`;
}

/* ── Request creation (approval-gated) ─────────────────────────────────── */

export type DeployRequestSpec = {
  ref: string;
  targetEnv: "preview" | "production";
  justification: string;
};

export type DeployRequestOutcome =
  | { ok: true; status: "created" | "pending_approval"; requestId?: string; changeRequestId?: string }
  | { ok: false; status: number; error: string };

/**
 * Creates a deploy/rollback approval request. Git ref must be in the allowed
 * deploy-ref set (default: main only). Production is high-risk (change-request
 * approval required); preview is medium-risk (proceeds without a change
 * request for non-breakglass roles).
 */
export async function requestDeploy(
  db: SupabaseClient,
  actor: SystemActor,
  spec: DeployRequestSpec,
): Promise<DeployRequestOutcome> {
  const ref = spec.ref.trim();
  if (!isAllowedDeployRef(ref)) {
    return { ok: false, status: 400, error: `ref not allowed for API deploys — allowed: ${allowedDeployRefs().join(", ") || "(none)"}` };
  }
  const justification = spec.justification.trim();
  if (justification.length < 10) {
    return { ok: false, status: 400, error: "justification must be at least 10 characters" };
  }

  const gate = await assertApprovedOrRequest(db, actor, {
    action: `deployment.deploy:${spec.targetEnv}`,
    risk: spec.targetEnv === "production" ? "high" : "medium",
    justification: `Deploy ${ref} → ${spec.targetEnv}: ${justification}`.slice(0, 4000),
  });
  if (gate.status === "pending") {
    return { ok: true, status: "pending_approval", changeRequestId: gate.changeRequestId };
  }
  if (gate.status === "rejected") {
    return { ok: false, status: 409, error: "A previous change request for this action was rejected" };
  }
  if (gate.status === "error") {
    return { ok: false, status: 500, error: gate.error };
  }

  const created = await createDeploymentRequest(db, actor, {
    action: "deploy",
    targetEnv: spec.targetEnv,
    justification,
  });
  if (!created.ok) return { ok: false, status: created.status, error: created.error };

  // Persist the deploy ref + env on the request row so execute can resolve it.
  await db.from("system_deployment_requests").update({
    result: { ref, provider: "vercel", requested_via: "deploy_center" },
  }).eq("id", created.request.id);

  await systemAudit(db, {
    actor,
    action: "deployment.deploy_requested",
    resource: `deployment_request:${created.request.id}`,
    detail: { ref, target_env: spec.targetEnv },
  });
  return { ok: true, status: "created", requestId: created.request.id };
}

/**
 * Rollback eligibility: candidates are READY production deployments from the
 * provider, excluding the most recent one (the current production deploy).
 * Returns honest empty state when the provider is unconfigured.
 */
export async function rollbackCandidates(): Promise<
  | { configured: false }
  | { configured: true; ok: true; candidates: VercelDeployment[] }
  | { configured: true; ok: false; error: string }
> {
  if (!vercelConfigured()) return { configured: false };
  const res = await listVercelDeployments(50);
  if (!res.configured) return { configured: false };
  if (!res.ok) return { configured: true, ok: false, error: res.error };
  const ready = res.data
    .filter((d) => d.readyState === "READY" && d.target === "production")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  // Exclude the newest — rolling back to the current deploy is a no-op.
  return { configured: true, ok: true, candidates: ready.slice(1) };
}

export type RollbackRequestOutcome =
  | { ok: true; status: "created" | "pending_approval"; requestId?: string; changeRequestId?: string; migrationWarning: string }
  | { ok: false; status: number; error: string };

/** Creates an approval-gated rollback request targeting a specific deployment. */
export async function requestRollback(
  db: SupabaseClient,
  actor: SystemActor,
  input: { deploymentId: string; justification: string },
): Promise<RollbackRequestOutcome> {
  const justification = input.justification.trim();
  if (justification.length < 10) {
    return { ok: false, status: 400, error: "justification must be at least 10 characters" };
  }
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(input.deploymentId)) {
    return { ok: false, status: 400, error: "invalid deployment id" };
  }

  // Verify the target is an eligible rollback candidate when the provider is live.
  const rb = await rollbackCandidates();
  if (rb.configured && rb.ok) {
    if (!rb.candidates.some((d) => d.uid === input.deploymentId)) {
      return { ok: false, status: 409, error: "deployment is not an eligible rollback target (must be a previous READY production deployment)" };
    }
  } else if (rb.configured) {
    return { ok: false, status: 502, error: `provider check failed: ${rb.error}` };
  }
  // Provider unconfigured → manual rollback request is still allowed; the human
  // performs the promote in the Vercel dashboard.

  const gate = await assertApprovedOrRequest(db, actor, {
    action: "deployment.rollback:production",
    risk: "high",
    justification: `Rollback production to deployment ${input.deploymentId}: ${justification}`.slice(0, 4000),
  });
  if (gate.status === "pending") {
    return { ok: true, status: "pending_approval", changeRequestId: gate.changeRequestId, migrationWarning: ROLLBACK_MIGRATION_WARNING };
  }
  if (gate.status === "rejected") {
    return { ok: false, status: 409, error: "A previous change request for this action was rejected" };
  }
  if (gate.status === "error") {
    return { ok: false, status: 500, error: gate.error };
  }

  const created = await createDeploymentRequest(db, actor, {
    action: "rollback",
    targetEnv: "production",
    justification,
  });
  if (!created.ok) return { ok: false, status: created.status, error: created.error };

  await db.from("system_deployment_requests").update({
    result: { target_deployment_id: input.deploymentId, provider: "vercel", requested_via: "deploy_center" },
  }).eq("id", created.request.id);

  await systemAudit(db, {
    actor,
    action: "deployment.rollback_requested",
    resource: `deployment_request:${created.request.id}`,
    detail: { target_deployment_id: input.deploymentId, migration_warning_acknowledged: true },
  });
  return { ok: true, status: "created", requestId: created.request.id, migrationWarning: ROLLBACK_MIGRATION_WARNING };
}

/* ── Provider execution ────────────────────────────────────────────────── */

export type ProviderExecuteResult =
  | { status: "executed"; requestId: string; deploymentId: string; url: string | null; mode: "provider";
      /** Honest post-accept state — 'executed' ≠ 'healthy'. */
      providerState: DeploymentState | null; health: DeploymentHealth | null; terminal: boolean }
  | { status: "provider_error"; requestId: string; error: string; mode: "provider" }
  | { status: "awaiting_manual_deploy"; requestId: string; reason: string; providerTokenPresent: boolean; mode: "manual" };

/**
 * Executes an approved (or preview-pending) deployment request through the
 * Vercel API. Falls back to the manual awaiting_manual_deploy contract when
 * Vercel is not configured.
 *
 * Gating:
 *  - production: request must be 'approved', executor ≠ requester, AND a live
 *    step-up elevation (requireElevation) is mandatory.
 *  - preview:    request may be 'pending' or 'approved' (lower bar — manage
 *    permission enforced at the route); no elevation required.
 */
export async function executeDeploymentCenterRequest(
  db: SupabaseClient,
  actor: SystemActor,
  user: SessionUser,
  requestId: string,
): Promise<{ ok: true; result: ProviderExecuteResult } | { ok: false; status: number; error: string; code?: string }> {
  const { request: req, error } = await getDeploymentRequest(db, requestId);
  if (error) return { ok: false, status: 500, error };
  if (!req) return { ok: false, status: 404, error: "Deployment request not found" };

  const isProduction = req.target_env === "production";
  const allowedStatus = isProduction ? "approved" : (req.status === "pending" || req.status === "approved");
  if (!allowedStatus) {
    return { ok: false, status: 409, error: `Request is ${req.status} — ${isProduction ? "only approved requests can be executed" : "only pending or approved requests can be executed"}` };
  }
  if (isProduction && req.requested_by === actor.id) {
    return { ok: false, status: 403, error: "Requester cannot execute their own production deployment request" };
  }

  // Provider not configured → delegate to the existing manual contract.
  if (!vercelConfigured()) {
    const manual = await executeDeploymentRequest(db, actor, requestId);
    if (!manual.ok) return manual;
    return {
      ok: true,
      result: { ...manual.result, mode: "manual" },
    };
  }

  // Production execution requires a fresh step-up elevation.
  if (isProduction) {
    const elev = await requireElevation(db, user);
    if (!elev.ok) return { ok: false, status: elev.status, error: elev.error, code: elev.code };
  }

  const meta = (typeof req.result === "object" && req.result ? req.result : {}) as Record<string, unknown>;
  const failWith = async (message: string, extra: Record<string, unknown> = {}) => {
    await db.from("system_deployment_requests").update({
      result: { ...meta, last_provider_attempt: { at: new Date().toISOString(), by: actor.id, outcome: "provider_error" }, last_provider_error: message.slice(0, 300) },
    }).eq("id", requestId);
    await systemAudit(db, {
      actor,
      action: "deployment.execute_failed",
      resource: `deployment_request:${requestId}`,
      detail: { action: req.action, target_env: req.target_env, error: message.slice(0, 200) },
    });
    return { ok: true as const, result: { status: "provider_error" as const, requestId, error: message, mode: "provider" as const } };
  };

  let providerDeploymentId: string | null = null;
  let providerUrl: string | null = null;

  if (req.action === "deploy") {
    const ref = typeof meta.ref === "string" ? meta.ref : null;
    if (!ref) return failWith("request has no deploy ref — create it via POST /api/system/deployments/request-deploy");
    // Defense in depth: the allowlist is enforced at request creation, but a
    // stored ref is re-validated here so a tampered/legacy row can never
    // reach the provider. Branch/tag names only — SHAs must be allowlisted
    // literally via GITHUB_DEPLOY_REFS.
    if (!isAllowedDeployRef(ref)) {
      return failWith(`stored ref '${ref.slice(0, 80)}' is not in the allowed deploy-ref set (${allowedDeployRefs().join(", ") || "none"})`);
    }
    const created = await createVercelDeployment({ ref, target: isProduction ? "production" : "preview" });
    if (!("ok" in created)) {
      return failWith("vercel provider reported unconfigured mid-flight");
    }
    if (!created.ok) return failWith(created.reason);
    providerDeploymentId = created.deploymentId;
    providerUrl = created.url;
  } else if (req.action === "rollback" || req.action === "promote") {
    const targetId = typeof meta.target_deployment_id === "string" ? meta.target_deployment_id : null;
    if (!targetId) return failWith("request has no target deployment — create it via POST /api/system/deployments/rollback");
    const promoted = await promoteVercelDeployment(targetId);
    if (!promoted.configured) return failWith("vercel provider reported unconfigured mid-flight");
    if (!promoted.ok) return failWith(promoted.error);
    providerDeploymentId = targetId;
    const detail = await getVercelDeployment(targetId);
    if (detail.configured && detail.ok) providerUrl = detail.data.url ? `https://${detail.data.url}` : null;
  } else {
    return { ok: false, status: 400, error: `unsupported action '${req.action}'` };
  }

  // Success: mark executed with provider metadata (never tokens). 'executed'
  // means the provider ACCEPTED the deployment — it is NOT proof the deploy
  // is live/healthy. The initial monitor pass below records the honest
  // provider state; result.health is only populated once the deployment
  // reports READY *and* the production URL probe passes.
  const executedResult: Record<string, unknown> = {
    ...meta,
    provider: "vercel",
    provider_deployment_id: providerDeploymentId,
    provider_url: providerUrl,
    executed_at: new Date().toISOString(),
    executed_by: actor.id,
  };
  await db.from("system_deployment_requests").update({
    status: "executed",
    result: executedResult,
  }).eq("id", requestId);

  await systemAudit(db, {
    actor,
    action: "deployment.executed",
    resource: `deployment_request:${requestId}`,
    detail: {
      action: req.action,
      target_env: req.target_env,
      provider: "vercel",
      provider_deployment_id: providerDeploymentId,
      ref: typeof meta.ref === "string" ? meta.ref : undefined,
    },
  });

  // Single bounded monitor pass (the UI keeps polling via /monitor). Failure
  // here must not fail the execute — the deployment was already accepted.
  const monitor = await monitorRequest(db, actor, { ...req, status: "executed", result: executedResult });

  return {
    ok: true,
    result: {
      status: "executed",
      requestId,
      deploymentId: providerDeploymentId ?? "",
      url: providerUrl,
      mode: "provider",
      providerState: monitor.state,
      health: monitor.health,
      terminal: monitor.terminal,
    },
  };
}

/* ── Detail view ───────────────────────────────────────────────────────── */

export type DeploymentDetail = {
  deployment: VercelDeployment | null;
  events: VercelDeploymentEvent[] | null;
  eventsStatus: "ok" | "requires_credentials" | "error" | "unavailable";
  eventsError: string | null;
  request: DeploymentRequestRow | null;
};

/**
 * Detail for one deployment. `id` may be a Vercel deployment uid (dpl_…) or a
 * deployment-request UUID. Events come from the provider when configured;
 * otherwise 'requires_credentials'.
 */
export async function getDeploymentDetail(db: SupabaseClient | null, id: string): Promise<DeploymentDetail | null> {
  const out: DeploymentDetail = { deployment: null, events: null, eventsStatus: "unavailable", eventsError: null, request: null };

  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  const isProviderId = /^[A-Za-z0-9_-]{4,100}$/.test(id);

  if (isUuid && db) {
    const { request } = await getDeploymentRequest(db, id);
    out.request = request;
  }

  // UUIDs are request ids, not provider deployment uids — skip the provider call.
  if (isProviderId && !isUuid && vercelConfigured()) {
    const dep = await getVercelDeployment(id);
    if (dep.configured && dep.ok) {
      out.deployment = dep.data;
      const ev = await getVercelDeploymentEvents(id, 100);
      if (ev.configured && ev.ok) {
        out.events = ev.data;
        out.eventsStatus = "ok";
      } else if (ev.configured) {
        out.eventsStatus = "error";
        out.eventsError = ev.error;
      } else {
        out.eventsStatus = "requires_credentials";
      }
    } else if (dep.configured) {
      out.eventsStatus = "error";
      out.eventsError = dep.error;
    } else {
      out.eventsStatus = "requires_credentials";
    }
  } else if (isProviderId && !isUuid) {
    out.eventsStatus = "requires_credentials";
    out.eventsError = `missing env: ${vercelGate().missing.join(", ") || "VERCEL_TOKEN, VERCEL_PROJECT_ID"}`;
  }

  if (!out.deployment && !out.request) return null;
  return out;
}

/** Manual deploy instructions shown whenever the provider can't execute. */
export function manualDeployInstructions(action: string, targetEnv: string): string[] {
  const steps = [
    `Push the approved ref to the repository (git push origin <ref>).`,
    `In the Vercel dashboard → project → Deployments, confirm the build for ${targetEnv} succeeds.`,
    `Verify the deployment URL responds, then record the outcome on this request.`,
  ];
  if (action === "rollback" || action === "promote") {
    steps[1] = `In the Vercel dashboard → project → Deployments, open the target deployment → "Instant Rollback" / Promote to production.`;
  }
  return steps;
}

/* ── Post-deploy monitoring + health checks ────────────────────────────── */

/**
 * Result of an HTTP probe against a deployment URL. `probeable:false` means
 * the URL failed the allowlist (probeableUrl) and was NEVER fetched.
 */
export type DeploymentHealth = {
  status: "healthy" | "unhealthy" | "skipped" | "unknown";
  checkedAt: string;
  /** HTTP status of the probe, or null when the request never completed. */
  httpStatus: number | null;
  /** The exact URL probed (already allowlist-normalized), or null. */
  url: string | null;
  detail: string | null;
};

export type MonitorOutcome = {
  ok: boolean;
  requestId: string;
  found: boolean;
  requestStatus: string | null;
  /** Mapped deployment state (building/queued/ready/error/canceled/…). */
  state: DeploymentState | null;
  providerStateRaw: string | null;
  /** True when the provider reports a terminal state (ready/error/canceled). */
  terminal: boolean;
  health: DeploymentHealth | null;
  /** Latest app health-profile result stored on the request (www profile after READY+production). */
  healthProfile: HealthProfileResult | null;
  error: string | null;
};

const TERMINAL_STATES: ReadonlySet<DeploymentState> = new Set(["ready", "error", "canceled"]);

/** Min interval between app health-profile runs during monitor polling. */
const HEALTH_PROFILE_REFRESH_MS = 120_000;

/**
 * Bounded HTTP probe for post-deploy health. Only ever fetches URLs that pass
 * probeableUrl (*.vercel.app or DEPLOY_PROBE_DOMAINS). HEAD first; on 405/501
 * falls back to a single GET. Healthy = final status 200–399.
 */
export async function probeDeploymentHealth(
  rawUrl: string | null,
  timeoutMs = 3500,
): Promise<{ probeable: boolean; httpStatus: number | null; healthy: boolean | null; url: string | null }> {
  const target = probeableUrl(rawUrl);
  if (!target) return { probeable: false, httpStatus: null, healthy: null, url: null };
  const attempt = async (method: "HEAD" | "GET") => {
    const res = await fetch(target, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 501) status = await attempt("GET");
    return { probeable: true, httpStatus: status, healthy: status >= 200 && status < 400, url: target };
  } catch {
    return { probeable: true, httpStatus: null, healthy: false, url: target };
  }
}

function healthFromProbe(
  probe: Awaited<ReturnType<typeof probeDeploymentHealth>>,
  checkedAt: string,
): DeploymentHealth {
  if (!probe.probeable) {
    return { status: "skipped", checkedAt, httpStatus: null, url: null, detail: "url not probeable (not *.vercel.app / DEPLOY_PROBE_DOMAINS)" };
  }
  if (probe.healthy === null) {
    return { status: "unknown", checkedAt, httpStatus: probe.httpStatus, url: probe.url, detail: "probe request did not complete" };
  }
  return {
    status: probe.healthy ? "healthy" : "unhealthy",
    checkedAt,
    httpStatus: probe.httpStatus,
    url: probe.url,
    detail: probe.healthy ? `HTTP ${probe.httpStatus}` : `HTTP ${probe.httpStatus ?? "none"} — deployment not serving`,
  };
}

/**
 * Runs the production health probe for an executed request and persists
 * result.health. Audited as 'deployment.health_checked' — the caller decides
 * whether to audit (monitorDeployment only audits on status transitions;
 * the explicit health-check route always audits).
 */
async function applyDeploymentHealth(
  db: SupabaseClient,
  actor: SystemActor,
  req: DeploymentRequestRow,
  meta: Record<string, unknown>,
  candidateUrl: string | null,
): Promise<DeploymentHealth> {
  const checkedAt = new Date().toISOString();
  const probe = await probeDeploymentHealth(candidateUrl);
  const health = healthFromProbe(probe, checkedAt);
  await db.from("system_deployment_requests").update({
    result: { ...meta, health },
  }).eq("id", req.id);
  return health;
}

async function auditHealth(
  db: SupabaseClient,
  actor: SystemActor,
  requestId: string,
  health: DeploymentHealth,
  prevStatus: string | null,
): Promise<void> {
  if (prevStatus === health.status) return; // only audit transitions/first check
  await systemAudit(db, {
    actor,
    action: "deployment.health_checked",
    resource: `deployment_request:${requestId}`,
    detail: {
      health_status: health.status,
      http_status: health.httpStatus,
      url: health.url,
    },
  });
}

/**
 * Single bounded monitor pass for one execution request. The UI polls this —
 * it NEVER blocks waiting for the provider; each call performs at most one
 * GET /v13/deployments/{uid} plus (only when READY + production) one HTTP
 * probe. State is persisted to result.provider_monitor so refreshes and the
 * list view reflect the latest known state.
 *
 * Health rule: only target_env 'production' deployments that report READY are
 * probed. 'executed' is never treated as healthy — result.health.status must
 * be 'healthy' for the deployment to count as verified-live.
 */
async function monitorRequest(
  db: SupabaseClient,
  actor: SystemActor,
  req: DeploymentRequestRow,
): Promise<MonitorOutcome> {
  const meta = (typeof req.result === "object" && req.result ? req.result : {}) as Record<string, unknown>;
  const pid = typeof meta.provider_deployment_id === "string" ? meta.provider_deployment_id : null;
  const out = (patch: Partial<MonitorOutcome>): MonitorOutcome => ({
    ok: true, requestId: req.id, found: true, requestStatus: req.status,
    state: null, providerStateRaw: null, terminal: false, health: null, healthProfile: null, error: null, ...patch,
  });

  if (!pid) {
    // Nothing provider-side to monitor — request-level state is the truth.
    const state = REQUEST_STATE[req.status] ?? "unknown";
    return out({ state, terminal: ["executed", "failed", "rejected"].includes(req.status) });
  }
  if (!vercelConfigured()) {
    return out({ state: "unknown", error: "vercel provider not configured", terminal: false });
  }

  const dep = await getVercelDeployment(pid);
  if (!dep.configured || !dep.ok) {
    return out({ state: "unknown", providerStateRaw: null, error: dep.configured ? dep.error : "unconfigured mid-flight", terminal: false });
  }

  const state = vercelState(dep.data.readyState, dep.data.target);
  const storedUrl = typeof meta.provider_url === "string" ? meta.provider_url : null;
  const providerUrl = storedUrl ?? (dep.data.url ? `https://${dep.data.url}` : null);
  const checkedAt = new Date().toISOString();

  // Persist the latest provider state on the request row.
  const priorHealth = (typeof meta.health === "object" && meta.health ? meta.health : null) as DeploymentHealth | null;
  let health = priorHealth;
  let healthProfile = (typeof meta.healthProfile === "object" && meta.healthProfile
    ? meta.healthProfile : null) as HealthProfileResult | null;
  let nextMeta: Record<string, unknown> = {
    ...meta,
    provider_monitor: { state, raw: dep.data.readyState, checked_at: checkedAt },
  };

  if (state === "ready" && req.target_env === "production") {
    health = await applyDeploymentHealth(db, actor, req, nextMeta, providerUrl);
    nextMeta = { ...nextMeta, health };
    await auditHealth(db, actor, req.id, health, priorHealth?.status ?? null);

    // In addition to the single-URL probe, run the www app health profile —
    // but at most once per HEALTH_PROFILE_REFRESH_MS so the 15s UI poll
    // doesn't fan out ~6 fetches every tick. A degraded profile is audited
    // ('deployment.health_degraded') and stored on the request; it NEVER
    // triggers an automatic rollback.
    const prevProfile = (typeof meta.healthProfile === "object" && meta.healthProfile
      ? meta.healthProfile : null) as HealthProfileResult | null;
    const ranAtMs = prevProfile?.ranAt ? Date.parse(prevProfile.ranAt) : 0;
    if (!ranAtMs || Date.now() - ranAtMs > HEALTH_PROFILE_REFRESH_MS) {
      try {
        const profile = await runAndRecordHealthProfile(db, actor, "www", {
          prevStatus: prevProfile?.status ?? null,
        });
        nextMeta = { ...nextMeta, healthProfile: profile };
        healthProfile = profile;
      } catch {
        /* profile failure must never break the monitor pass */
      }
    } else {
      healthProfile = prevProfile;
    }
  }

  await db.from("system_deployment_requests").update({ result: nextMeta }).eq("id", req.id);

  return out({
    state,
    providerStateRaw: dep.data.readyState,
    terminal: TERMINAL_STATES.has(state),
    health,
    healthProfile,
  });
}

/**
 * Monitor entry point for API routes: loads the request, then runs one
 * bounded provider check. `found:false` when the request id doesn't exist.
 */
export async function monitorDeployment(
  db: SupabaseClient,
  actor: SystemActor,
  requestId: string,
): Promise<MonitorOutcome> {
  const { request, error } = await getDeploymentRequest(db, requestId);
  if (error) {
    return { ok: false, requestId, found: false, requestStatus: null, state: null, providerStateRaw: null, terminal: false, health: null, healthProfile: null, error };
  }
  if (!request) {
    return { ok: false, requestId, found: false, requestStatus: null, state: null, providerStateRaw: null, terminal: false, health: null, healthProfile: null, error: "Deployment request not found" };
  }
  return monitorRequest(db, actor, request);
}

/**
 * Explicit health-check trigger (POST /api/system/deployments/[id]/health-check).
 * Probes the deployment URL NOW regardless of provider build state and always
 * audits 'deployment.health_checked'. Requires an executed request with a
 * provider_deployment_id.
 */
export async function checkDeploymentHealthNow(
  db: SupabaseClient,
  actor: SystemActor,
  requestId: string,
): Promise<{ ok: boolean; error?: string; health?: DeploymentHealth; requestId: string }> {
  const { request, error } = await getDeploymentRequest(db, requestId);
  if (error) return { ok: false, error, requestId };
  if (!request) return { ok: false, error: "Deployment request not found", requestId };
  const meta = (typeof request.result === "object" && request.result ? request.result : {}) as Record<string, unknown>;
  const pid = typeof meta.provider_deployment_id === "string" ? meta.provider_deployment_id : null;
  if (!pid) return { ok: false, error: "request has no provider deployment — nothing to health-check", requestId };
  if (!vercelConfigured()) return { ok: false, error: "vercel provider not configured", requestId };

  // Resolve the freshest URL from the provider when possible.
  let url = typeof meta.provider_url === "string" ? meta.provider_url : null;
  const dep = await getVercelDeployment(pid);
  if (dep.configured && dep.ok && dep.data.url) url = `https://${dep.data.url}`;

  const health = await applyDeploymentHealth(db, actor, request, meta, url);
  await systemAudit(db, {
    actor,
    action: "deployment.health_checked",
    resource: `deployment_request:${requestId}`,
    detail: { health_status: health.status, http_status: health.httpStatus, url: health.url, manual: true },
  });
  return { ok: true, health, requestId };
}

/* ── Rollback ↔ migration compatibility ────────────────────────────────── */

/**
 * Rollbacks promote an OLD deployment but NEVER revert database migrations —
 * migrations are forward-only. This warning is shown unconditionally on every
 * rollback UI and returned by the API; the operator must explicitly confirm.
 */
export const ROLLBACK_MIGRATION_WARNING =
  "Rollback does NOT revert database migrations. Supabase migrations are forward-only — rolling back code to an older deployment can leave the schema ahead of (or incompatible with) that code. Verify schema compatibility between the target deployment and the current database manually before approving.";

/**
 * Per-candidate rollback annotation. We cannot prove schema compatibility —
 * the manifest tracks repo files, not per-file applied state, and deployment
 * timestamps don't map to migration dates — so this is honest metadata only:
 * candidate age plus the standing "migrations are never reverted" note with
 * the latest repo migration for reference. Never marks a candidate
 * 'rollback_ineligible' on schema grounds; eligibility stays with
 * rollbackCandidates() (previous READY production deployments only).
 */
export function migrationCompatNote(candidate: { createdAt: number | null }): {
  ageDays: number | null;
  latestMigrationFile: string | null;
  note: string;
} {
  const latest = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1] : null;
  const ageDays = typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
    ? Math.max(0, Math.floor((Date.now() - candidate.createdAt) / 86_400_000))
    : null;
  return {
    ageDays,
    latestMigrationFile: latest?.file ?? null,
    note: `Rollback never reverts migrations${latest ? ` — repo latest is ${latest.file}` : ""}. Verify this deployment's code is compatible with the CURRENT database schema before approving.`,
  };
}

export type RollbackCompatibility = {
  /** Repo truth: migrations defined in supabase/migrations (manifest). */
  repoMigrationCount: number;
  latestMigration: { file: string; number: number | null; title: string } | null;
  /**
   * Whether a migration-tracking table is queryable via PostgREST.
   * 'unavailable' is the expected/honest state — Supabase does not expose
   * per-file applied state through supabase_migrations to the REST API, so
   * the repo manifest is the only reliable truth here.
   */
  dbMigrationTracking: "queryable" | "unavailable";
  appliedCount: number | null;
  warning: string;
};

export async function rollbackCompatibility(db: SupabaseClient | null): Promise<RollbackCompatibility> {
  const latest = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1] : null;
  let dbMigrationTracking: RollbackCompatibility["dbMigrationTracking"] = "unavailable";
  let appliedCount: number | null = null;
  if (db) {
    try {
      const { count, error } = await db
        .from("supabase_migrations")
        .select("version", { count: "exact", head: true })
        .limit(1);
      if (!error) {
        dbMigrationTracking = "queryable";
        appliedCount = typeof count === "number" ? count : null;
      }
    } catch {
      /* table not exposed via PostgREST — expected */
    }
  }
  return {
    repoMigrationCount: MIGRATIONS.length,
    latestMigration: latest ? { file: latest.file, number: latest.number, title: latest.title } : null,
    dbMigrationTracking,
    appliedCount,
    warning: ROLLBACK_MIGRATION_WARNING,
  };
}
