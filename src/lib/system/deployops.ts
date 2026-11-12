import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Deployment-operations workflow (system.zapnivo.com → App → Deployments).
 *
 * This module manages REQUESTS AND DECISIONS only. There is no deployment
 * provider client: no Vercel/Netlify API token is used for execution, and no
 * deploy API call is ever made from this codebase. "Executing" an approved
 * request always resolves to `awaiting_manual_deploy` — a human deploys via
 * `git push` / the Vercel dashboard, then marks the request executed/fixed
 * through the normal change process.
 */

export const DEPLOY_ACTIONS = ["deploy", "rollback", "promote"] as const;
export type DeployAction = (typeof DEPLOY_ACTIONS)[number];
export const isDeployAction = (v: unknown): v is DeployAction =>
  typeof v === "string" && (DEPLOY_ACTIONS as readonly string[]).includes(v);

export const DEPLOY_TARGET_ENVS = ["production", "preview", "development"] as const;

export type DeploymentRequestRow = {
  id: string;
  action: DeployAction;
  target_env: string;
  justification: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  result: unknown;
  created_at: string;
};

export const DEPLOY_REQUEST_SELECT =
  "id,action,target_env,justification,status,requested_by,decided_by,decided_at,result,created_at";

export async function listDeploymentRequests(db: SupabaseClient, limit = 100): Promise<{ requests: DeploymentRequestRow[]; error: string | null }> {
  const { data, error } = await db
    .from("system_deployment_requests")
    .select(DEPLOY_REQUEST_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (/does not exist|relation|schema cache/i.test(error.message)) return { requests: [], error: null };
    return { requests: [], error: error.message };
  }
  return { requests: (data ?? []) as DeploymentRequestRow[], error: null };
}

/**
 * Creates a PENDING deployment request. Justification is required — an
 * unexplained deploy/rollback is not approvable. The row itself never executes
 * anything; approval + manual deploy are separate steps.
 */
export async function createDeploymentRequest(
  db: SupabaseClient,
  actor: SystemActor,
  input: { action: DeployAction; targetEnv?: string; justification: string },
): Promise<{ ok: true; request: DeploymentRequestRow } | { ok: false; status: number; error: string }> {
  const justification = input.justification.trim();
  if (justification.length < 10) {
    return { ok: false, status: 400, error: "justification must be at least 10 characters" };
  }
  const targetEnv = (input.targetEnv ?? "production").slice(0, 40);
  if (!(DEPLOY_TARGET_ENVS as readonly string[]).includes(targetEnv)) {
    return { ok: false, status: 400, error: `target_env must be one of: ${DEPLOY_TARGET_ENVS.join(", ")}` };
  }

  const { data, error } = await db.from("system_deployment_requests").insert({
    action: input.action,
    target_env: targetEnv,
    justification: justification.slice(0, 4000),
    status: "pending",
    requested_by: actor.id,
  }).select(DEPLOY_REQUEST_SELECT).single();

  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  const row = data as DeploymentRequestRow;

  await systemAudit(db, {
    actor,
    action: "deployment.requested",
    resource: `deployment_request:${row.id}`,
    detail: { action: input.action, target_env: targetEnv },
  });
  return { ok: true, request: row };
}

/**
 * Approve/reject a pending deployment request. Separation of duties: the
 * decider must differ from the requester (same rule as system_change_requests).
 */
export async function decideDeploymentRequest(
  db: SupabaseClient,
  decider: SystemActor,
  requestId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<{ ok: true; request: DeploymentRequestRow } | { ok: false; status: number; error: string }> {
  const { data: existing, error: readErr } = await db
    .from("system_deployment_requests")
    .select(DEPLOY_REQUEST_SELECT)
    .eq("id", requestId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!existing) return { ok: false, status: 404, error: "Deployment request not found" };
  const req = existing as DeploymentRequestRow;
  if (req.status !== "pending") {
    return { ok: false, status: 409, error: `Deployment request already ${req.status}` };
  }
  if (req.requested_by === decider.id) {
    return { ok: false, status: 403, error: "Separation of duties: you cannot decide your own deployment request" };
  }

  const { data: updated, error } = await db
    .from("system_deployment_requests")
    .update({
      status: decision,
      decided_by: decider.id,
      decided_at: new Date().toISOString(),
      result: note ? { note: note.slice(0, 2000) } : null,
    })
    .eq("id", requestId)
    .select(DEPLOY_REQUEST_SELECT)
    .single();
  if (error || !updated) return { ok: false, status: 500, error: error?.message ?? "update failed" };

  await systemAudit(db, {
    actor: decider,
    action: decision === "approved" ? "deployment.approved" : "deployment.rejected",
    resource: `deployment_request:${requestId}`,
    detail: { action: req.action, target_env: req.target_env, requester: req.requested_by, note: note?.slice(0, 500) },
  });
  return { ok: true, request: updated as DeploymentRequestRow };
}

export type ExecuteResult = {
  status: "awaiting_manual_deploy";
  requestId: string;
  reason: string;
  /** True when VERCEL_TOKEN is present — still never used to call a deploy API. */
  providerTokenPresent: boolean;
};

/**
 * "Execution" of an approved deployment request. There is deliberately NO
 * provider API call in this codebase: the response always reports
 * awaiting_manual_deploy with instructions. If a request is not approved, or
 * the requester tries to self-execute their own approval, it is refused.
 */
export async function executeDeploymentRequest(
  db: SupabaseClient,
  actor: SystemActor,
  requestId: string,
): Promise<{ ok: true; result: ExecuteResult } | { ok: false; status: number; error: string }> {
  const { data: existing, error: readErr } = await db
    .from("system_deployment_requests")
    .select(DEPLOY_REQUEST_SELECT)
    .eq("id", requestId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!existing) return { ok: false, status: 404, error: "Deployment request not found" };
  const req = existing as DeploymentRequestRow;

  if (req.status !== "approved") {
    return { ok: false, status: 409, error: `Request is ${req.status} — only approved requests can be executed` };
  }
  // Separation of duties extends to execution: approver ≠ requester already,
  // and the executor should not be the requester either.
  if (req.requested_by === actor.id) {
    return { ok: false, status: 403, error: "Requester cannot execute their own deployment request" };
  }

  const providerTokenPresent = Boolean(process.env.VERCEL_TOKEN);
  const result: ExecuteResult = {
    status: "awaiting_manual_deploy",
    requestId,
    reason: providerTokenPresent
      ? "VERCEL_TOKEN is configured but no deployment client is implemented in this app — deploy via git push / the Vercel dashboard, then record the outcome."
      : "no provider token — deploy via git push / the Vercel dashboard, then record the outcome.",
    providerTokenPresent,
  };

  // Record the attempt on the row (result jsonb) without changing status —
  // 'executed'/'failed' are set by a human after the real deploy happens.
  await db.from("system_deployment_requests").update({
    result: {
      ...(typeof req.result === "object" && req.result ? (req.result as Record<string, unknown>) : {}),
      last_execute_attempt: { at: new Date().toISOString(), by: actor.id, status: "awaiting_manual_deploy" },
    },
  }).eq("id", requestId);

  await systemAudit(db, {
    actor,
    action: "deployment.execute_attempted",
    resource: `deployment_request:${requestId}`,
    detail: { action: req.action, target_env: req.target_env, outcome: "awaiting_manual_deploy" },
  });
  return { ok: true, result };
}
