import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
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

export const INCIDENT_STATUSES = ["detected", "investigating", "identified", "mitigating", "monitoring", "resolved", "reopened"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const isIncidentStatus = (v: unknown): v is IncidentStatus =>
  typeof v === "string" && (INCIDENT_STATUSES as readonly string[]).includes(v);

/**
 * Legal incident lifecycle edges (validated server-side in transitionIncident).
 * 'reopened' is the explicit reopen state — reachable only from resolved or
 * monitoring, and ALWAYS requires a reason. 'reopened' re-enters the normal
 * forward flow (investigating → … → resolved).
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  detected: ["investigating", "identified", "mitigating", "monitoring", "resolved"],
  investigating: ["identified", "mitigating", "monitoring", "resolved"],
  identified: ["mitigating", "monitoring", "resolved"],
  mitigating: ["monitoring", "resolved", "investigating"],
  monitoring: ["resolved", "reopened"],
  resolved: ["reopened"],
  reopened: ["investigating", "identified", "mitigating", "monitoring", "resolved"],
};

/** Targets that require a non-empty reason (reopen must be justified). */
export const REASON_REQUIRED_TARGETS: readonly IncidentStatus[] = ["reopened"];

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;

/** Evidence link kinds storable on incidents.links (jsonb, no FK — mixed targets). */
export const INCIDENT_LINK_TYPES = ["error_issue", "deployment", "device", "change_request", "incident", "other"] as const;
export type IncidentLinkType = (typeof INCIDENT_LINK_TYPES)[number];
export type IncidentLink = { type: IncidentLinkType; id: string; label?: string };

export const isIncidentLink = (v: unknown): v is IncidentLink => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" && (INCIDENT_LINK_TYPES as readonly string[]).includes(o.type)
    && typeof o.id === "string" && o.id.length > 0 && o.id.length <= 200
    && (o.label === undefined || (typeof o.label === "string" && o.label.length <= 200));
};

export type IncidentRow = {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: IncidentStatus | string;
  source: string | null;
  services: string[];
  /** Assignee — profiles.id of a system user (migration 0026 `owner` column). */
  owner: string | null;
  summary: string | null;
  resolution_notes: string | null;
  links: IncidentLink[];
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

const SELECT = "id,number,title,severity,status,source,services,owner,summary,resolution_notes,links,detected_at,acknowledged_at,resolved_at,created_at";

/** Normalizes the links jsonb column into validated IncidentLink[] (fault-tolerant). */
export function parseIncidentLinks(raw: unknown): IncidentLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isIncidentLink).slice(0, 50).map((l) => ({
    type: l.type, id: l.id.slice(0, 200), ...(l.label ? { label: l.label.slice(0, 200) } : {}),
  }));
}

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
  const rows = ((data ?? []) as IncidentRow[]).map((r) => ({
    ...r,
    summary: r.summary ? scrub(r.summary, 1000) : null,
    links: parseIncidentLinks(r.links),
  }));
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

/* ── Lifecycle transitions (phase 7) ──────────────────────────────────────── */

export const transitionSchema = z.object({
  to_status: z.enum(INCIDENT_STATUSES),
  reason: z.string().trim().max(1000).optional(),
  /** Required when to_status='resolved' (min 3 chars) — what fixed it. */
  resolution_notes: z.string().trim().max(4000).optional(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export type IncidentEventRow = {
  id: string;
  incident_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  reason: string | null;
  created_at: string;
};

export async function getIncident(db: SupabaseClient, incidentId: string): Promise<IncidentRow | null> {
  const { data, error } = await db.from("incidents").select(SELECT).eq("id", incidentId).maybeSingle();
  if (error || !data) return null;
  const row = data as IncidentRow;
  return { ...row, links: parseIncidentLinks(row.links) };
}

/** Append-only transition history for one incident, oldest first. */
export async function listIncidentEvents(db: SupabaseClient, incidentId: string, limit = 200): Promise<IncidentEventRow[]> {
  const { data } = await db.from("system_incident_events")
    .select("id,incident_id,from_status,to_status,actor_id,reason,created_at")
    .eq("incident_id", incidentId)
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 500));
  return (data ?? []) as IncidentEventRow[];
}

export type TransitionResult =
  | { ok: true; incident: IncidentRow; event: IncidentEventRow | null; changeRequestId: string | null }
  | { ok: false; status: number; error: string; reason?: string; allowed?: readonly string[] };

/**
 * Moves an incident along INCIDENT_TRANSITIONS. Illegal edges → 409 (with the
 * allowed targets). 'reopened' requires a non-empty reason. Routed through
 * assertApprovedOrRequest (risk: low) so breakglass actors still need an
 * approved change request. Every executed transition writes a
 * system_incident_events row + a system_audit_events row; resolved_at is set
 * on →resolved and cleared when leaving resolved/reopened.
 */
export async function transitionIncident(
  db: SupabaseClient,
  actor: SystemActor,
  incidentId: string,
  toStatus: IncidentStatus,
  reason?: string,
  resolutionNotes?: string,
): Promise<TransitionResult> {
  const { data: inc, error } = await db.from("incidents").select(SELECT).eq("id", incidentId).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!inc) return { ok: false, status: 404, error: "Incident not found" };
  const row = inc as IncidentRow;
  const from = isIncidentStatus(row.status) ? row.status : null;
  if (!from) return { ok: false, status: 409, error: `Incident has non-lifecycle status "${row.status}"` };
  if (from === toStatus) return { ok: false, status: 409, error: `Incident is already ${toStatus}`, allowed: INCIDENT_TRANSITIONS[from] };
  const allowed = INCIDENT_TRANSITIONS[from];
  if (!allowed.includes(toStatus)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${toStatus}`, allowed };
  }
  const trimmedReason = reason?.trim() ?? "";
  if (REASON_REQUIRED_TARGETS.includes(toStatus) && trimmedReason.length < 3) {
    return { ok: false, status: 422, error: "reason_required", reason: "Reopening an incident requires a reason (min 3 chars)." };
  }
  // Resolving requires a resolution note — `resolution_notes` wins, `reason`
  // is accepted as a fallback so older callers keep working.
  const notes = (resolutionNotes?.trim() || (toStatus === "resolved" ? trimmedReason : ""));
  if (toStatus === "resolved" && notes.length < 3) {
    return { ok: false, status: 422, error: "resolution_notes_required", reason: "Resolving an incident requires resolution notes (min 3 chars)." };
  }

  const action = `incident.transition:${row.number}:${from}_to_${toStatus}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: trimmedReason || `Transition incident ${row.number} ${from} → ${toStatus}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "incident.transition_pending", resource: `incident:${row.id}`, detail: { changeRequestId: approval.changeRequestId, from, to: toStatus } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — transition executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const patch: Record<string, unknown> = { status: toStatus };
  if (toStatus === "resolved") {
    patch.resolved_at = new Date().toISOString();
    patch.resolution_notes = notes.slice(0, 4000);
  }
  if (from === "resolved" || toStatus === "reopened") {
    patch.resolved_at = null;
    patch.resolution_notes = null; // stale resolution notes must not survive a reopen
  }

  const { data: updated, error: upErr } = await db
    .from("incidents")
    .update(patch)
    .eq("id", row.id)
    .select(SELECT)
    .single();
  if (upErr) return { ok: false, status: 500, error: upErr.message };

  let event: IncidentEventRow | null = null;
  const { data: ev } = await db.from("system_incident_events").insert({
    incident_id: row.id,
    from_status: from,
    to_status: toStatus,
    actor_id: actor.id,
    reason: trimmedReason || null,
  }).select("id,incident_id,from_status,to_status,actor_id,reason,created_at").single();
  if (ev) event = ev as IncidentEventRow;

  await systemAudit(db, {
    actor, action: "incident.transitioned", resource: `incident:${row.id}`,
    detail: { number: row.number, from, to: toStatus, reason: trimmedReason || undefined, resolution_notes: toStatus === "resolved" ? notes.slice(0, 500) : undefined, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, incident: (updated as IncidentRow) ?? row, event, changeRequestId: approval.changeRequestId };
}

/* ── Assignment, notes, evidence (phase 4.4) ─────────────────────────────── */

export type IncidentMutationResult =
  | { ok: true; incident: IncidentRow; changeRequestId: string | null }
  | { ok: false; status: number; error: string; reason?: string };

type IncidentLoad =
  | { row: IncidentRow }
  | { error: { ok: false; status: number; error: string; reason?: string } };

async function loadIncidentOr404(db: SupabaseClient, incidentId: string): Promise<IncidentLoad> {
  const { data: inc, error } = await db.from("incidents").select(SELECT).eq("id", incidentId).maybeSingle();
  if (error) return { error: { ok: false as const, status: 500, error: error.message } };
  if (!inc) return { error: { ok: false as const, status: 404, error: "Incident not found" } };
  const row = inc as IncidentRow;
  return { row: { ...row, links: parseIncidentLinks(row.links) } };
}

/**
 * Assigns (or clears, assigneeId=null) the incident owner. The assignee must be
 * a profiles row holding a system_role — business-only users cannot own system
 * incidents. Idempotent: re-assigning the same owner is a no-op success.
 * Audited as incident.assigned / incident.unassigned.
 */
export async function assignIncident(
  db: SupabaseClient,
  actor: SystemActor,
  incidentId: string,
  assigneeId: string | null,
  justification?: string,
): Promise<IncidentMutationResult> {
  const loaded = await loadIncidentOr404(db, incidentId);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;

  if (assigneeId !== null) {
    if (!/^[0-9a-f-]{36}$/i.test(assigneeId)) return { ok: false, status: 422, error: "invalid_assignee", reason: "Assignee must be a user id." };
    if (assigneeId === row.owner) return { ok: true, incident: row, changeRequestId: null };
    const { data: prof, error: pErr } = await db
      .from("profiles").select("id,system_role,system_suspended").eq("id", assigneeId).maybeSingle();
    if (pErr) return { ok: false, status: 500, error: pErr.message };
    const p = prof as { system_role?: string | null; system_suspended?: boolean | null } | null;
    if (!p) return { ok: false, status: 404, error: "User not found" };
    if (!p.system_role) return { ok: false, status: 422, error: "not_a_system_user", reason: "Assignee must hold a system role." };
    if (p.system_suspended === true) return { ok: false, status: 422, error: "assignee_suspended", reason: "Assignee's system access is suspended." };
  } else if (row.owner === null) {
    return { ok: true, incident: row, changeRequestId: null };
  }

  const action = assigneeId ? `incident.assign:${row.number}` : `incident.unassign:${row.number}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: justification ?? `${assigneeId ? `Assign ${row.number} to ${assigneeId}` : `Unassign ${row.number}`}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: `${action}_pending`, resource: `incident:${row.id}`, detail: { changeRequestId: approval.changeRequestId, assignee: assigneeId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — assignment executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("incidents")
    .update({ owner: assigneeId })
    .eq("id", row.id)
    .select(SELECT)
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const next = (updated as IncidentRow | null) ?? { ...row, owner: assigneeId };

  await systemAudit(db, {
    actor,
    action: assigneeId ? "incident.assigned" : "incident.unassigned",
    resource: `incident:${row.id}`,
    detail: { number: row.number, assignee: assigneeId, previous: row.owner, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, incident: { ...next, links: parseIncidentLinks(next.links) }, changeRequestId: approval.changeRequestId };
}

/**
 * Appends an investigation note. Notes are stored as append-only
 * system_audit_events rows (action 'incident.note') — they appear in the
 * incident timeline alongside transitions. Free text is scrubbed before
 * storage; 3–2000 chars.
 */
export async function addIncidentNote(
  db: SupabaseClient,
  actor: SystemActor,
  incidentId: string,
  note: string,
): Promise<IncidentMutationResult> {
  const trimmed = note.trim();
  if (trimmed.length < 3) return { ok: false, status: 422, error: "note_required", reason: "Note must be at least 3 characters." };
  if (trimmed.length > 2000) return { ok: false, status: 422, error: "note_too_long", reason: "Note must be 2000 characters or fewer." };
  const loaded = await loadIncidentOr404(db, incidentId);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;

  const action = `incident.note:${row.number}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: `Add investigation note to ${row.number}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "incident.note_pending", resource: `incident:${row.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — note executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  await systemAudit(db, {
    actor, action: "incident.note", resource: `incident:${row.id}`,
    detail: { number: row.number, note: scrub(trimmed, 2000), changeRequestId: approval.changeRequestId },
  });
  return { ok: true, incident: row, changeRequestId: approval.changeRequestId };
}

/**
 * Links evidence to an incident (error_issue / deployment / device /
 * change_request ids — stored in incidents.links jsonb since there is no
 * single FK target). Links are validated, deduplicated on type+id, capped at
 * 50, and merged into the existing array. Audited as incident.evidence_linked.
 */
export async function linkIncidentEvidence(
  db: SupabaseClient,
  actor: SystemActor,
  incidentId: string,
  links: unknown,
): Promise<IncidentMutationResult> {
  if (!Array.isArray(links) || links.length === 0) {
    return { ok: false, status: 422, error: "links_required", reason: "Expected a non-empty array of {type,id,label?} links." };
  }
  if (links.length > 20) return { ok: false, status: 422, error: "too_many_links", reason: "At most 20 links per call." };
  const clean = links.filter(isIncidentLink).map((l) => ({
    type: l.type, id: l.id.trim().slice(0, 200), ...(l.label?.trim() ? { label: l.label.trim().slice(0, 200) } : {}),
  }));
  if (clean.length === 0) return { ok: false, status: 422, error: "invalid_links", reason: "No valid links — type must be one of error_issue|deployment|device|change_request|incident|other." };

  const loaded = await loadIncidentOr404(db, incidentId);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;

  const seen = new Set(row.links.map((l) => `${l.type}:${l.id}`));
  const merged = [...row.links];
  for (const l of clean) {
    const key = `${l.type}:${l.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(l);
  }
  if (merged.length > 50) return { ok: false, status: 422, error: "too_many_links", reason: "Incident already has the maximum of 50 links." };
  if (merged.length === row.links.length) {
    return { ok: true, incident: row, changeRequestId: null }; // all duplicates — no-op
  }

  const action = `incident.evidence:${row.number}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: `Link ${clean.length} evidence item(s) to ${row.number}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "incident.evidence_pending", resource: `incident:${row.id}`, detail: { changeRequestId: approval.changeRequestId, links: clean.length } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — linking executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("incidents")
    .update({ links: merged })
    .eq("id", row.id)
    .select(SELECT)
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const next = (updated as IncidentRow | null) ?? { ...row, links: merged };

  await systemAudit(db, {
    actor, action: "incident.evidence_linked", resource: `incident:${row.id}`,
    detail: { number: row.number, added: clean, total: merged.length, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, incident: { ...next, links: parseIncidentLinks(next.links) }, changeRequestId: approval.changeRequestId };
}

/** System users eligible for incident assignment (system_role set, not suspended). */
export type AssignableUser = { id: string; email: string | null; full_name: string | null; system_role: string };
export async function listAssignableUsers(db: SupabaseClient | null): Promise<{ configured: boolean; users: AssignableUser[] }> {
  if (!db) return { configured: false, users: [] };
  const { data, error } = await db
    .from("profiles")
    .select("id,email,full_name,system_role,system_suspended")
    .not("system_role", "is", null)
    .limit(200);
  if (error) return { configured: true, users: [] };
  const users = ((data ?? []) as (AssignableUser & { system_suspended?: boolean | null })[])
    .filter((u) => u.system_suspended !== true)
    .map((u) => ({ id: u.id, email: u.email ?? null, full_name: u.full_name ?? null, system_role: u.system_role }));
  return { configured: true, users };
}

/* ── Timeline (transitions + audit events) ───────────────────────────────── */

export type IncidentTimelineEntry =
  | { kind: "transition"; id: string; at: string; from: string | null; to: string; actor: string | null; reason: string | null }
  | { kind: "audit"; id: string; at: string; action: string; actor: string | null; actorRole: string | null; detail: Record<string, unknown> };

/**
 * Merged incident timeline: system_incident_events (status transitions) plus
 * system_audit_events rows scoped to this incident (notes, assignments,
 * evidence links, acknowledge/transition audit entries). Newest first,
 * bounded to `limit` entries total.
 */
export async function getIncidentTimeline(
  db: SupabaseClient,
  incidentId: string,
  limit = 200,
): Promise<{ events: IncidentEventRow[]; timeline: IncidentTimelineEntry[] }> {
  const events = await listIncidentEvents(db, incidentId, limit);
  const { data } = await db
    .from("system_audit_events")
    .select("id,action,actor_id,actor_role,detail,created_at")
    .eq("resource", `incident:${incidentId}`)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  const auditRows = ((data ?? []) as { id: string; action: string; actor_id: string | null; actor_role: string | null; detail: Record<string, unknown> | null; created_at: string }[])
    .filter((a) => typeof a.action === "string" && a.action.startsWith("incident."));

  const timeline: IncidentTimelineEntry[] = [
    ...events.map((e): IncidentTimelineEntry => ({
      kind: "transition", id: e.id, at: e.created_at, from: e.from_status, to: e.to_status,
      actor: e.actor_id, reason: e.reason,
    })),
    ...auditRows.map((a): IncidentTimelineEntry => ({
      kind: "audit", id: a.id, at: a.created_at, action: a.action,
      actor: a.actor_id, actorRole: a.actor_role, detail: a.detail ?? {},
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);

  return { events, timeline };
}
