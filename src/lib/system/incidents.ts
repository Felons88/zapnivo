import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";
import { assertApprovedOrRequest, systemAudit, type SystemActor } from "./audit";

/**
 * Incident read model + acknowledge for the system console.
 *
 * Source: the `incidents` table (migration 0026_observability.sql) — the
 * observability incident ledger written by uptime/cron/error-spike monitors.
 * Columns used: id, number, title, severity, status, source, services, summary,
 * detected_at, acknowledged_at, resolved_at. `owner` is a profiles FK — the
 * console shows incidents without resolving owner emails (not needed for ops).
 *
 * Acknowledge = stamp `acknowledged_at` only (status lifecycle — detected →
 * investigating → … → resolved — is owned by the incident workflow, not this
 * console). Idempotent: acknowledging an already-acknowledged open incident is
 * a no-op success; resolved incidents return 409.
 *
 * There is NO dedicated incident permission in SYSTEM_PERMISSIONS. The page/API
 * therefore use `system.security.audit.view` for reads and mutations additionally
 * require `system.changes.request` (the broadest mutation perm held by hardware/
 * engineer/security/sysadmin/breakglass) — viewers and developers get read-only.
 */

export const INCIDENT_STATUSES = ["detected", "investigating", "identified", "mitigating", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const isIncidentStatus = (v: unknown): v is IncidentStatus =>
  typeof v === "string" && (INCIDENT_STATUSES as readonly string[]).includes(v);

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;

export type IncidentRow = {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: IncidentStatus | string;
  source: string | null;
  services: string[];
  summary: string | null;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

const SELECT = "id,number,title,severity,status,source,services,summary,detected_at,acknowledged_at,resolved_at,created_at";

/** Lists incidents newest-first. `status` filters exactly; "open" means not resolved. */
export async function listIncidents(
  db: SupabaseClient | null,
  opts: { status?: string; limit?: number } = {},
): Promise<{ configured: boolean; rows: IncidentRow[] }> {
  if (!db) return { configured: false, rows: [] };
  let q = db.from("incidents").select(SELECT).order("detected_at", { ascending: false });
  if (opts.status === "open") q = q.neq("status", "resolved");
  else if (isIncidentStatus(opts.status)) q = q.eq("status", opts.status);
  const { data, error } = await q.limit(Math.min(Math.max(opts.limit ?? 100, 1), 300));
  if (error) return { configured: true, rows: [] };
  const rows = ((data ?? []) as IncidentRow[]).map((r) => ({ ...r, summary: r.summary ? scrub(r.summary, 1000) : null }));
  return { configured: true, rows };
}

export type AcknowledgeResult =
  | { ok: true; incident: IncidentRow; alreadyAcknowledged: boolean; changeRequestId: string | null }
  | { ok: false; status: number; error: string; reason?: string };

/**
 * Stamps acknowledged_at on an open incident. Routed through
 * assertApprovedOrRequest so breakglass-role actors still need an approved
 * change request (risk: low — acknowledging is reversible and non-destructive).
 */
export async function acknowledgeIncident(
  db: SupabaseClient,
  actor: SystemActor,
  incidentId: string,
  justification?: string,
): Promise<AcknowledgeResult> {
  const { data: inc, error } = await db
    .from("incidents")
    .select(SELECT)
    .eq("id", incidentId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!inc) return { ok: false, status: 404, error: "Incident not found" };
  const row = inc as IncidentRow;
  if (row.status === "resolved") {
    return { ok: false, status: 409, error: "already_resolved", reason: "Resolved incidents cannot be acknowledged." };
  }
  if (row.acknowledged_at) {
    return { ok: true, incident: row, alreadyAcknowledged: true, changeRequestId: null };
  }

  const action = `incident.acknowledge:${row.number}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: justification ?? `Acknowledge incident ${row.number} (${row.severity}/${row.status}).`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "incident.acknowledge_pending", resource: `incident:${row.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — acknowledgement executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("incidents")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("acknowledged_at", null) // optimistic guard: only stamp once
    .select(SELECT)
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  if (!updated) {
    // Someone else acknowledged concurrently — re-read and report honestly.
    const { data: again } = await db.from("incidents").select(SELECT).eq("id", row.id).maybeSingle();
    return { ok: true, incident: (again as IncidentRow) ?? row, alreadyAcknowledged: true, changeRequestId: approval.changeRequestId };
  }

  await systemAudit(db, {
    actor, action: "incident.acknowledged", resource: `incident:${row.id}`,
    detail: { number: row.number, severity: row.severity, status: row.status, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, incident: updated as IncidentRow, alreadyAcknowledged: false, changeRequestId: approval.changeRequestId };
}
