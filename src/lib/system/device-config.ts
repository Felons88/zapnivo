import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, assertApprovedOrRequest, type ChangeRisk, type SystemActor } from "./audit";
import {
  deviceAuditResource, isUuid, kioskAdapterName,
  type SystemDeviceRow,
} from "./kiosks";

/**
 * Desired-state device configuration (System Control → KIOSK INFRASTRUCTURE).
 *
 * Backed by migration 0059 `device_config_revisions`. A revision is a
 * whitelist-validated `desired` jsonb document moving through:
 *
 *   draft → approved → (dispatch) → awaiting_report → applied | failed
 *   any open revision → superseded when a newer one is approved
 *
 * HONESTY NOTES
 * ──────────────
 * - The `desired` whitelist is enforced HERE (application layer), matching how
 *   system_device_commands.payload is handled — the DB stores jsonb.
 * - Dispatch writes a `system_device_commands` row with command_type
 *   'config_update'. With KIOSK_ADAPTER=none (the only real adapter today)
 *   there is no dispatch path: the command is recorded state='failed' with
 *   result.reason='adapter_disabled'/'adapter_unavailable' — NEVER 'sent' —
 *   and the revision lands 'failed'. 'awaiting_report' is only reachable once
 *   a real adapter queues the command as pending/sent.
 * - There is currently NO reported-config channel in ingest
 *   (src/lib/kiosk/ingest.ts carries telemetry + command acks only).
 *   reconcileReported() is implemented and tested so a future telemetry field
 *   (e.g. event payload `reported_config`) can call it; until then revisions
 *   honestly stay awaiting_report/failed and `reported` stays null.
 * - Rollback is a NEW revision whose desired equals the previously applied
 *   revision's desired — history is never rewritten.
 */

/* ── Whitelist ────────────────────────────────────────────────────────────── */

export type ConfigScalar = string | number | boolean | null;

export const CONFIG_KEY_SPECS = {
  /** Seconds between heartbeats the device should emit. */
  heartbeat_interval_sec: { kind: "int" as const, min: 15, max: 86_400 },
  /** Device enters maintenance mode (no customer dispensing). Medium risk. */
  maintenance_mode: { kind: "bool" as const },
  /** Advertising playlist identifier; null clears it. */
  ad_playlist_id: { kind: "string" as const, max: 120, nullable: true },
  /** Display brightness 0–100. */
  brightness: { kind: "number" as const, min: 0, max: 100 },
  /** Free-text ops note stored on the device config (≤2000 chars). */
  config_notes: { kind: "string" as const, max: 2000, nullable: true },
} as const;

export type ConfigKey = keyof typeof CONFIG_KEY_SPECS;
export const CONFIG_KEYS = Object.keys(CONFIG_KEY_SPECS) as ConfigKey[];

/** Keys requiring step-up elevation (physical-affecting). NONE today — every
 *  whitelisted key is display/telemetry/maintenance-flag level. If a future
 *  key can affect dispensing or payment hardware it MUST be added here. */
export const ELEVATED_CONFIG_KEYS: readonly ConfigKey[] = [];
/** Keys that change device behaviour in the field → medium change risk. */
export const MEDIUM_CONFIG_KEYS: readonly ConfigKey[] = ["maintenance_mode"];

export type DesiredConfig = Partial<Record<ConfigKey, ConfigScalar>>;

export type ConfigValidation =
  | { ok: true; desired: DesiredConfig }
  | { ok: false; error: string; issues: string[] };

/**
 * Strict whitelist validation. Rejects unknown keys, wrong types, out-of-range
 * values, and non-plain-object input. Returns a NORMALIZED desired object
 * (strings trimmed, ints floored-checked).
 */
export function validateDesiredConfig(raw: unknown): ConfigValidation {
  const issues: string[] = [];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "desired must be a JSON object", issues: ["desired_not_object"] };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "desired must set at least one whitelisted key", issues: ["desired_empty"] };
  }
  const desired: DesiredConfig = {};
  for (const [key, value] of entries) {
    const spec = (CONFIG_KEY_SPECS as Record<string, { kind: string; min?: number; max?: number; nullable?: boolean }>)[key];
    if (!spec) {
      issues.push(`unknown config key "${key}" — allowed: ${CONFIG_KEYS.join(", ")}`);
      continue;
    }
    if (value === null) {
      if (spec.nullable) { desired[key as ConfigKey] = null; continue; }
      issues.push(`"${key}" does not accept null`);
      continue;
    }
    if (spec.kind === "bool") {
      if (typeof value !== "boolean") { issues.push(`"${key}" must be a boolean`); continue; }
      desired[key as ConfigKey] = value;
    } else if (spec.kind === "int" || spec.kind === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) { issues.push(`"${key}" must be a number`); continue; }
      if (spec.kind === "int" && !Number.isInteger(value)) { issues.push(`"${key}" must be an integer`); continue; }
      if (spec.min != null && value < spec.min) { issues.push(`"${key}" below minimum ${spec.min}`); continue; }
      if (spec.max != null && value > spec.max) { issues.push(`"${key}" above maximum ${spec.max}`); continue; }
      desired[key as ConfigKey] = value;
    } else {
      if (typeof value !== "string") { issues.push(`"${key}" must be a string`); continue; }
      const trimmed = value.trim();
      if (spec.max != null && trimmed.length > spec.max) { issues.push(`"${key}" exceeds ${spec.max} chars`); continue; }
      desired[key as ConfigKey] = trimmed;
    }
  }
  if (issues.length > 0 || Object.keys(desired).length === 0) {
    return { ok: false, error: issues[0] ?? "no valid config keys", issues };
  }
  return { ok: true, desired };
}

/** Deep-equal on the whitelisted key set (order-insensitive). */
export function desiredEquals(a: DesiredConfig, b: DesiredConfig): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ka = a[k as ConfigKey], kb = b[k as ConfigKey];
    if (ka !== kb) return false;
  }
  return true;
}

/** Whitelisted subset of an arbitrary reported object (unknown keys dropped). */
export function sanitizeReportedConfig(raw: unknown): { ok: true; reported: DesiredConfig } | { ok: false; error: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "reported config must be a JSON object" };
  }
  const out: DesiredConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in CONFIG_KEY_SPECS)) continue; // unknown reported keys are ignored, not fatal
    const one = validateDesiredConfig({ [k]: v });
    if (one.ok) Object.assign(out, one.desired);
  }
  return { ok: true, reported: out };
}

/* ── Revision rows ────────────────────────────────────────────────────────── */

export const CONFIG_REVISION_STATUSES = [
  "draft", "approved", "awaiting_report", "applied", "failed", "superseded",
] as const;
export type ConfigRevisionStatus = (typeof CONFIG_REVISION_STATUSES)[number];

export type ConfigRevisionRow = {
  id: string;
  device_id: string;
  revision: number;
  desired: DesiredConfig;
  status: ConfigRevisionStatus;
  command_id: string | null;
  reported: DesiredConfig | null;
  actor: string | null;
  created_at: string;
};

export const CONFIG_REVISION_SELECT =
  "id,device_id,revision,desired,status,command_id,reported,actor,created_at";

/** Device statuses allowed to hold config revisions (field-deployable set). */
export const CONFIG_ELIGIBLE_STATUSES: readonly string[] = ["active", "testing", "maintenance"];

const OPEN_REVISION_STATUSES: readonly ConfigRevisionStatus[] = ["draft", "approved", "awaiting_report"];

async function latestRevision(db: SupabaseClient, deviceId: string): Promise<ConfigRevisionRow | null> {
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT)
    .eq("device_id", deviceId)
    .order("revision", { ascending: false })
    .limit(1);
  return ((data ?? [])[0] as ConfigRevisionRow | undefined) ?? null;
}

export async function listConfigRevisions(db: SupabaseClient, deviceId: string, limit = 100): Promise<ConfigRevisionRow[]> {
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT)
    .eq("device_id", deviceId)
    .order("revision", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));
  return (data ?? []) as ConfigRevisionRow[];
}

async function insertRevision(
  db: SupabaseClient,
  device: SystemDeviceRow,
  desired: DesiredConfig,
  status: ConfigRevisionStatus,
  actor: SystemActor,
  extra: { command_id?: string | null; reported?: DesiredConfig | null } = {},
): Promise<{ ok: true; revision: ConfigRevisionRow } | { ok: false; status: number; error: string }> {
  const latest = await latestRevision(db, device.id);
  const revision = (latest?.revision ?? 0) + 1;
  const { data, error } = await db.from("device_config_revisions").insert({
    device_id: device.id,
    revision,
    desired,
    status,
    command_id: extra.command_id ?? null,
    reported: extra.reported ?? null,
    actor: actor.id,
  }).select(CONFIG_REVISION_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  return { ok: true, revision: data as ConfigRevisionRow };
}

/* ── propose ──────────────────────────────────────────────────────────────── */

export type ConfigOpResult =
  | { ok: true; revision: ConfigRevisionRow }
  | { ok: false; status: number; error: string; pending?: boolean; changeRequestId?: string };

/**
 * Creates a 'draft' revision. Validates the whitelist and device eligibility
 * (must be active|testing|maintenance — decommissioned/quarantined/pending
 * devices cannot receive config).
 */
export async function proposeConfig(
  db: SupabaseClient,
  device: SystemDeviceRow,
  rawDesired: unknown,
  actor: SystemActor,
): Promise<ConfigOpResult> {
  const v = validateDesiredConfig(rawDesired);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  if (device.status === "decommissioned") return { ok: false, status: 409, error: "Cannot configure a decommissioned device" };
  if (!CONFIG_ELIGIBLE_STATUSES.includes(device.status)) {
    return { ok: false, status: 409, error: `Device status "${device.status}" cannot receive config (requires ${CONFIG_ELIGIBLE_STATUSES.join("|")})` };
  }
  const ins = await insertRevision(db, device, v.desired, "draft", actor);
  if (!ins.ok) return ins;
  await systemAudit(db, {
    actor, action: "kiosk.config_proposed", resource: deviceAuditResource(device.id),
    detail: { revision: ins.revision.revision, desired: v.desired, device_uid: device.device_uid },
  });
  return { ok: true, revision: ins.revision };
}

/* ── approve ──────────────────────────────────────────────────────────────── */

/**
 * draft → approved. Risk is computed from the desired keys: elevated keys
 * (none today) would force 'critical'; medium keys (maintenance_mode) force
 * 'medium' → change-request gate for breakglass/high risk via
 * assertApprovedOrRequest. Returns pending when a change request was created.
 */
export function configRisk(desired: DesiredConfig): ChangeRisk {
  const keys = Object.keys(desired) as ConfigKey[];
  if (keys.some((k) => (ELEVATED_CONFIG_KEYS as readonly string[]).includes(k))) return "critical";
  if (keys.some((k) => (MEDIUM_CONFIG_KEYS as readonly string[]).includes(k))) return "medium";
  return "low";
}

export async function approveConfig(
  db: SupabaseClient,
  device: SystemDeviceRow,
  revisionId: string,
  actor: SystemActor,
  justification?: string,
): Promise<ConfigOpResult> {
  if (!isUuid(revisionId)) return { ok: false, status: 400, error: "Invalid revision id" };
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT).eq("id", revisionId).eq("device_id", device.id).maybeSingle();
  const rev = data as ConfigRevisionRow | null;
  if (!rev) return { ok: false, status: 404, error: "Config revision not found" };
  if (rev.status !== "draft") return { ok: false, status: 409, error: `Revision is ${rev.status}, not draft` };

  const risk = configRisk(rev.desired);
  const approval = await assertApprovedOrRequest(db, actor, {
    action: `kiosk.config.approve_r${rev.revision}`,
    risk,
    justification: justification?.trim() || `Approve config revision ${rev.revision} for ${device.device_uid ?? device.id}`,
  });
  if (approval.status === "pending") {
    return { ok: false, status: 202, error: "Change request created — awaiting approval", pending: true, changeRequestId: approval.changeRequestId };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  // Supersede older open revisions — only one live desired-state at a time.
  await db.from("device_config_revisions")
    .update({ status: "superseded" })
    .eq("device_id", device.id)
    .in("status", [...OPEN_REVISION_STATUSES])
    .neq("id", rev.id);

  const { data: updated, error } = await db.from("device_config_revisions")
    .update({ status: "approved" })
    .eq("id", rev.id)
    .select(CONFIG_REVISION_SELECT).single();
  if (error || !updated) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.config_approved", resource: deviceAuditResource(device.id),
    detail: { revision: rev.revision, risk, change_request_id: approval.changeRequestId },
  });
  return { ok: true, revision: updated as ConfigRevisionRow };
}

/* ── dispatch ─────────────────────────────────────────────────────────────── */

export type DispatchResult =
  | { ok: true; revision: ConfigRevisionRow; command: { id: string; state: string } | null; dispatched: boolean }
  | { ok: false; status: number; error: string };

/**
 * approved → dispatch. Creates a system_device_commands row
 * (command_type='config_update', payload={revision, desired}). Because no live
 * adapter exists the command is recorded state='failed' with an honest reason
 * and the revision becomes 'failed'. A future real adapter path would leave
 * the command pending/sent and the revision 'awaiting_report'.
 */
export async function dispatchConfig(
  db: SupabaseClient,
  device: SystemDeviceRow,
  revisionId: string,
  actor: SystemActor,
): Promise<DispatchResult> {
  if (!isUuid(revisionId)) return { ok: false, status: 400, error: "Invalid revision id" };
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT).eq("id", revisionId).eq("device_id", device.id).maybeSingle();
  const rev = data as ConfigRevisionRow | null;
  if (!rev) return { ok: false, status: 404, error: "Config revision not found" };
  if (rev.status !== "approved") return { ok: false, status: 409, error: `Revision is ${rev.status} — only approved revisions can be dispatched` };

  const adapter = kioskAdapterName();
  // No adapter today can carry a config_update — record honestly as failed.
  const liveDispatch = adapter !== "none" && adapter !== "simulator";
  const commandState = liveDispatch ? "pending" : "failed";
  const commandResult = liveDispatch
    ? { dispatched_via: adapter }
    : { reason: adapter === "none" ? "adapter_disabled" : "adapter_unavailable", adapter, detail: "Config command recorded for audit only — no live hardware path; nothing was dispatched." };

  const { data: cmd, error: cmdErr } = await db.from("system_device_commands").insert({
    device_id: device.id,
    command_type: "config_update",
    payload: { config_revision_id: rev.id, revision: rev.revision, desired: rev.desired },
    state: commandState,
    issued_by: actor.id,
    result: liveDispatch ? null : commandResult,
  }).select("id,state").single();
  if (cmdErr || !cmd) return { ok: false, status: 500, error: cmdErr?.message ?? "command insert failed" };
  const command = cmd as { id: string; state: string };

  const nextStatus: ConfigRevisionStatus = liveDispatch ? "awaiting_report" : "failed";
  const { data: updated, error } = await db.from("device_config_revisions")
    .update({ status: nextStatus, command_id: command.id })
    .eq("id", rev.id)
    .select(CONFIG_REVISION_SELECT).single();
  if (error || !updated) return { ok: false, status: 500, error: error?.message ?? "revision update failed" };

  await systemAudit(db, {
    actor, action: "kiosk.config_dispatched", resource: deviceAuditResource(device.id),
    detail: {
      revision: rev.revision, command_id: command.id, command_state: command.state,
      adapter, dispatched: liveDispatch, outcome: nextStatus,
    },
  });
  return { ok: true, revision: updated as ConfigRevisionRow, command, dispatched: liveDispatch };
}

/* ── reported-state reconciliation ────────────────────────────────────────── */

/**
 * Records a device-reported config snapshot against the newest open/applied
 * revision. NOT currently wired into ingest (no reported-config channel
 * exists) — exposed for the future telemetry field and for tests/simulator.
 *
 * - reported keys are whitelist-filtered (unknown keys ignored).
 * - If reported covers every desired key and values match → status 'applied'.
 * - Otherwise the revision stays awaiting_report (or applied→reported refresh)
 *   and the mismatch is audited.
 */
export async function reconcileReported(
  db: SupabaseClient,
  device: SystemDeviceRow,
  rawReported: unknown,
  actor: SystemActor,
): Promise<{ ok: true; revision: ConfigRevisionRow; matched: boolean } | { ok: false; status: number; error: string }> {
  const san = sanitizeReportedConfig(rawReported);
  if (!san.ok) return { ok: false, status: 400, error: san.error };
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT)
    .eq("device_id", device.id)
    .in("status", ["approved", "awaiting_report", "applied"])
    .order("revision", { ascending: false })
    .limit(1);
  const rev = (data ?? [])[0] as ConfigRevisionRow | undefined;
  if (!rev) return { ok: false, status: 409, error: "No open or applied config revision to reconcile against" };

  const desiredKeys = Object.keys(rev.desired) as ConfigKey[];
  const covered = desiredKeys.every((k) => k in san.reported);
  const matched = covered && desiredEquals(rev.desired, { ...rev.desired, ...pickReported(san.reported, desiredKeys) });

  const nextStatus: ConfigRevisionStatus = matched ? "applied" : rev.status === "applied" ? "applied" : "awaiting_report";
  const { data: updated, error } = await db.from("device_config_revisions")
    .update({ reported: san.reported, status: nextStatus })
    .eq("id", rev.id)
    .select(CONFIG_REVISION_SELECT).single();
  if (error || !updated) return { ok: false, status: 500, error: error?.message ?? "update failed" };

  await systemAudit(db, {
    actor, action: matched ? "kiosk.config_applied" : "kiosk.config_reported_mismatch",
    resource: deviceAuditResource(device.id),
    detail: { revision: rev.revision, matched, reported: san.reported, status: nextStatus },
  });
  return { ok: true, revision: updated as ConfigRevisionRow, matched };
}

function pickReported(reported: DesiredConfig, keys: ConfigKey[]): DesiredConfig {
  const out: DesiredConfig = {};
  for (const k of keys) if (k in reported) out[k] = reported[k];
  return out;
}

/* ── rollback ─────────────────────────────────────────────────────────────── */

/**
 * Rollback = a NEW draft revision whose desired equals the previously APPLIED
 * revision's desired (the state before the latest applied change). History is
 * never rewritten; the new draft still needs approve → dispatch.
 */
export async function proposeRollback(
  db: SupabaseClient,
  device: SystemDeviceRow,
  actor: SystemActor,
): Promise<ConfigOpResult> {
  const { data } = await db.from("device_config_revisions")
    .select(CONFIG_REVISION_SELECT)
    .eq("device_id", device.id)
    .eq("status", "applied")
    .order("revision", { ascending: false })
    .limit(2);
  const applied = (data ?? []) as ConfigRevisionRow[];
  if (applied.length === 0) return { ok: false, status: 409, error: "No applied config revision to roll back from" };
  const previous = applied[1];
  if (!previous) {
    return { ok: false, status: 409, error: "Only one applied revision exists — nothing earlier to roll back to" };
  }
  const ins = await insertRevision(db, device, previous.desired, "draft", actor);
  if (!ins.ok) return ins;
  await systemAudit(db, {
    actor, action: "kiosk.config_rollback_proposed", resource: deviceAuditResource(device.id),
    detail: { new_revision: ins.revision.revision, restores_revision: previous.revision, device_uid: device.device_uid },
  });
  return { ok: true, revision: ins.revision };
}

/* ── Ops metadata tags (bulk assign_tags) ─────────────────────────────────── */

export const DEVICE_TAG_MAX = 20;
export const DEVICE_TAG_LEN = 40;

export function sanitizeTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") return null;
    const s = t.trim().slice(0, DEVICE_TAG_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= DEVICE_TAG_MAX) break;
  }
  return out;
}

/**
 * Writes metadata.tags on system_devices (column added in 0059). Read-modify-
 * write of the metadata bag; other metadata keys are preserved.
 */
export async function assignDeviceTags(
  db: SupabaseClient,
  device: SystemDeviceRow,
  tags: string[],
  actor: SystemActor,
): Promise<{ ok: true; tags: string[] } | { ok: false; status: number; error: string }> {
  const clean = sanitizeTags(tags);
  if (clean == null) return { ok: false, status: 400, error: `tags must be an array of ≤${DEVICE_TAG_MAX} strings (≤${DEVICE_TAG_LEN} chars each)` };
  const { data: row } = await db.from("system_devices").select("metadata").eq("id", device.id).maybeSingle();
  const meta = { ...(((row as { metadata?: Record<string, unknown> } | null)?.metadata) ?? {}) };
  meta.tags = clean;
  const { error } = await db.from("system_devices").update({ metadata: meta, updated_at: new Date().toISOString() }).eq("id", device.id);
  if (error) return { ok: false, status: 500, error: error.message };
  await systemAudit(db, {
    actor, action: "kiosk.tags_assigned", resource: deviceAuditResource(device.id),
    detail: { tags: clean, device_uid: device.device_uid },
  });
  return { ok: true, tags: clean };
}

/* ── Maintenance visit workflow (system_maintenance_visits, 0059) ───────────
 * Constants/types live in ./device-config.shared (client-safe, no server
 * imports); re-exported here so server callers keep one import surface. */

export {
  MAINTENANCE_VISIT_TYPES, MAINTENANCE_STATUSES, MAINTENANCE_TRANSITIONS,
  MAINTENANCE_VISIT_SELECT, canTransitionVisit,
} from "./device-config.shared";
export type { MaintenanceVisitType, MaintenanceStatus, MaintenanceVisitRow } from "./device-config.shared";
import {
  MAINTENANCE_STATUSES, MAINTENANCE_VISIT_SELECT, canTransitionVisit,
  type MaintenanceStatus, type MaintenanceVisitRow,
} from "./device-config.shared";

/** Column patch applied for a status transition (timestamps auto-set). */
export function visitTransitionPatch(to: MaintenanceStatus, now = new Date()): Record<string, unknown> {
  const iso = now.toISOString();
  const patch: Record<string, unknown> = { status: to, updated_at: iso };
  if (to === "in_progress") patch.started_at = iso;
  if (to === "completed" || to === "cancelled") patch.completed_at = iso;
  return patch;
}

export async function listMaintenanceVisits(
  db: SupabaseClient,
  opts: { deviceId?: string; status?: string; limit?: number } = {},
): Promise<MaintenanceVisitRow[]> {
  let q = db.from("system_maintenance_visits").select(MAINTENANCE_VISIT_SELECT)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  if (opts.deviceId && isUuid(opts.deviceId)) q = q.eq("device_id", opts.deviceId);
  if (opts.status && (MAINTENANCE_STATUSES as readonly string[]).includes(opts.status)) q = q.eq("status", opts.status);
  const { data } = await q;
  return (data ?? []) as MaintenanceVisitRow[];
}
