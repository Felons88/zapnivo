import type { SupabaseClient } from "@supabase/supabase-js";
import { newTraceId, recordLog, scrub } from "@/lib/observability";
import { mutationNeedsApproval, type SystemRole } from "./rbac";

/**
 * System-plane audit + change-request helpers. All writes go through the
 * service-role client; system_audit_events is append-only (select-only RLS).
 */

export type SystemActor = { id: string; role: SystemRole | string };
export type ChangeRisk = "low" | "medium" | "high" | "critical";
export const CHANGE_RISKS: readonly ChangeRisk[] = ["low", "medium", "high", "critical"];
/** Risks that always require an approved change request before execution. */
export const APPROVAL_RISKS: readonly ChangeRisk[] = ["high", "critical"];

export type SystemAuditInput = {
  actor: SystemActor | null;
  action: string;
  resource: string;
  detail?: Record<string, unknown>;
  environment?: string;
  correlationId?: string;
};

/**
 * Writes one system_audit_events row (best-effort) plus an observability log line.
 * Detail is size-capped and secret-scrubbed; never throws.
 */
export async function systemAudit(db: SupabaseClient | null | undefined, input: SystemAuditInput): Promise<void> {
  const correlationId = input.correlationId ?? newTraceId();
  const environment = input.environment ?? process.env.VERCEL_ENV ?? "development";
  try {
    if (db) {
      const detail = input.detail ?? {};
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(detail).slice(0, 30)) {
        if (/pass|secret|token|key|auth|cookie|otp|card|cvv|ssn/i.test(k)) continue;
        safe[k] = typeof v === "string" ? scrub(v, 500) : v;
      }
      await db.from("system_audit_events").insert({
        actor_id: input.actor?.id ?? null,
        actor_role: input.actor?.role ?? "system",
        action: scrub(input.action, 120),
        resource: scrub(input.resource, 200),
        environment,
        detail: safe,
        correlation_id: correlationId,
      });
    }
  } catch { /* audit must never break the action */ }
  recordLog("info", `system.${input.action}`, {
    service: "system",
    attrs: { resource: input.resource, environment, actor: input.actor?.id ?? "system", correlation_id: correlationId },
  });
}

export type ChangeRequestRow = {
  id: string;
  action: string;
  environment: string;
  risk: ChangeRisk;
  justification: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  result: unknown;
  created_at: string;
};

export type ApprovalResult =
  | { status: "approved"; changeRequestId: string | null }
  | { status: "pending"; changeRequestId: string }
  | { status: "rejected"; changeRequestId: string }
  | { status: "error"; error: string };

/**
 * Creates a pending change request for a high-risk system mutation.
 * Returns the new row id, or null on failure (caller should fail closed).
 */
export async function requestChange(
  db: SupabaseClient,
  actor: SystemActor,
  input: { action: string; environment?: string; risk: ChangeRisk; justification: string },
): Promise<{ id: string | null; error?: string }> {
  const { data, error } = await db
    .from("system_change_requests")
    .insert({
      action: input.action.slice(0, 200),
      environment: input.environment ?? process.env.VERCEL_ENV ?? "production",
      risk: input.risk,
      justification: input.justification.slice(0, 4000),
      status: "pending",
      requested_by: actor.id,
    })
    .select("id")
    .single();
  if (error || !data) return { id: null, error: error?.message ?? "insert failed" };
  await systemAudit(db, {
    actor, action: "change.requested", resource: `change_request:${(data as { id: string }).id}`,
    detail: { action: input.action, risk: input.risk, environment: input.environment },
  });
  return { id: (data as { id: string }).id };
}

/** True when an approved, non-self-decided change request covers this action. */
async function hasApprovedChange(
  db: SupabaseClient,
  actor: SystemActor,
  action: string,
  environment: string,
): Promise<{ id: string } | null> {
  const { data } = await db
    .from("system_change_requests")
    .select("id,decided_by")
    .eq("requested_by", actor.id)
    .eq("action", action)
    .eq("environment", environment)
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(5);
  const rows = (data ?? []) as { id: string; decided_by: string | null }[];
  // Separation of duties: the approver must be a different principal than the requester.
  const ok = rows.find((r) => r.decided_by && r.decided_by !== actor.id);
  return ok ? { id: ok.id } : null;
}

/**
 * Gate for mutating system routes. Rules:
 *  - breakglass role: EVERY mutation needs an approved change request for `action`.
 *  - any role: risk 'high'|'critical' needs an approved change request.
 *  - otherwise the mutation may proceed ({status:'approved'}).
 * When approval is required but missing, a pending change request is created and
 * {status:'pending'} returned — the route must NOT execute the mutation.
 */
export async function assertApprovedOrRequest(
  db: SupabaseClient,
  actor: SystemActor,
  input: { action: string; environment?: string; risk: ChangeRisk; justification: string },
): Promise<ApprovalResult> {
  const environment = input.environment ?? process.env.VERCEL_ENV ?? "production";
  const needsApproval = mutationNeedsApproval(actor.role as SystemRole) || APPROVAL_RISKS.includes(input.risk);
  if (!needsApproval) return { status: "approved", changeRequestId: null };

  const approved = await hasApprovedChange(db, actor, input.action, environment).catch(() => null);
  if (approved) return { status: "approved", changeRequestId: approved.id };

  const { id, error } = await requestChange(db, actor, { ...input, environment });
  if (!id) return { status: "error", error: error ?? "could not create change request" };
  await systemAudit(db, {
    actor, action: "change.pending", resource: `change_request:${id}`,
    detail: { action: input.action, risk: input.risk, reason: mutationNeedsApproval(actor.role as SystemRole) ? "breakglass" : "high_risk" },
  });
  return { status: "pending", changeRequestId: id };
}

/** Alias kept for route readability — same contract as assertApprovedOrRequest. */
export const requireApproval = assertApprovedOrRequest;

export type Decision = "approved" | "rejected";

/**
 * Applies approve/reject to a change request. Enforces separation of duties:
 * the decider must differ from the requester. Returns the updated row or an error.
 */
export async function decideChange(
  db: SupabaseClient,
  decider: SystemActor,
  changeRequestId: string,
  decision: Decision,
  note?: string,
): Promise<{ ok: true; row: ChangeRequestRow } | { ok: false; status: number; error: string }> {
  const { data: existing, error: readErr } = await db
    .from("system_change_requests")
    .select("id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at")
    .eq("id", changeRequestId)
    .maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!existing) return { ok: false, status: 404, error: "Change request not found" };
  const cr = existing as ChangeRequestRow;
  if (cr.status !== "pending") return { ok: false, status: 409, error: `Change request already ${cr.status}` };
  if (cr.requested_by === decider.id) {
    return { ok: false, status: 403, error: "Separation of duties: you cannot decide your own change request" };
  }
  const { data: updated, error } = await db
    .from("system_change_requests")
    .update({
      status: decision,
      decided_by: decider.id,
      decided_at: new Date().toISOString(),
      result: note ? { note: note.slice(0, 2000) } : null,
    })
    .eq("id", changeRequestId)
    .select("id,action,environment,risk,justification,status,requested_by,decided_by,decided_at,result,created_at")
    .single();
  if (error || !updated) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor: decider,
    action: decision === "approved" ? "change.approved" : "change.rejected",
    resource: `change_request:${changeRequestId}`,
    detail: { action: cr.action, risk: cr.risk, requester: cr.requested_by, note: note?.slice(0, 500) },
  });
  return { ok: true, row: updated as ChangeRequestRow };
}
