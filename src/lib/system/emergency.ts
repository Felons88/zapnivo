import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, assertApprovedOrRequest, type ChangeRisk, type SystemActor } from "./audit";
import { requireElevation } from "./elevation";
import { getDeviceAuthRow, revokeDeviceCredential, type DeviceAuthRow } from "./device-auth";
import { DEVICE_TRANSITIONS, getSystemDevice, isUuid, isSystemDeviceStatus, transitionRisk, type SystemDeviceStatus, type SystemDeviceRow } from "./kiosks";
import { setFeatureFlag } from "./flags";
import { getAgent } from "@/lib/agents/registry";
import { setAgentKillState } from "./ai";

/**
 * Emergency controls for system.zapnivo.com — SCOPED operations only.
 *
 * There is deliberately NO "disable everything" / global kill switch here.
 * Every operation is a typed, zod-validated action against ONE named target:
 *
 *   suspend_device_credential — revoke one device's ingest credential
 *   quarantine_device         — move one device to 'quarantined' (legal edges only)
 *   pause_integration_feature — disable one whitelisted noncritical feature flag
 *   disable_ai_agent          — kill-switch one registered agent
 *   maintenance_banner        — set/clear the 'maintenance.notice' flag with TTL
 *
 * Every op: requireElevation ALWAYS → assertApprovedOrRequest (breakglass and
 * high/critical risks need an approved change request) → typed mutation →
 * system_audit_events row (action 'emergency.<op>'). The route layer adds the
 * permission check (system.users.manage) + rate limit.
 */

export const EMERGENCY_OPS = [
  "suspend_device_credential",
  "quarantine_device",
  "pause_integration_feature",
  "disable_ai_agent",
  "maintenance_banner",
] as const;
export type EmergencyOp = (typeof EMERGENCY_OPS)[number];
export const isEmergencyOp = (v: unknown): v is EmergencyOp =>
  typeof v === "string" && (EMERGENCY_OPS as readonly string[]).includes(v);

/**
 * Feature flags an emergency op may pause. NONCRITICAL only — payment,
 * auth/session, and secret-rotation flags are intentionally absent. The flag
 * rows are control-plane metadata (env vars still govern runtime), so pausing
 * one records intent + audit, it does not silently change billing/auth.
 */
export const EMERGENCY_PAUSABLE_FLAGS: readonly string[] = [
  "receptionist_autosend",
  "ai_account_tools",
];
export const MAINTENANCE_FLAG_KEY = "maintenance.notice";

/** maintenance_banner TTL bounds (minutes). */
export const BANNER_MIN_MINUTES = 5;
export const BANNER_MAX_MINUTES = 240;
export const BANNER_DEFAULT_MINUTES = 60;

export type EmergencyInput = {
  op: EmergencyOp;
  /** Must literally equal the op name — typed confirmation against accidents. */
  confirm: string;
  /** Operator justification, audited. Min 10 chars. */
  reason: string;
  /** suspend_device_credential / quarantine_device: system_devices.id (uuid). */
  device_id?: string;
  /** pause_integration_feature: flag key (must be in EMERGENCY_PAUSABLE_FLAGS). */
  flag?: string;
  /** disable_ai_agent: ai_agents.id. */
  agent_id?: string;
  /** maintenance_banner: true=set notice, false=clear. */
  banner_enabled?: boolean;
  banner_message?: string;
  banner_minutes?: number;
};

export type EmergencyResult =
  | { ok: true; op: EmergencyOp; summary: string; expiresAt: string | null; changeRequestId: string | null }
  | { ok: false; status: number; error: string; code?: string; pending?: boolean; changeRequestId?: string };

const fail = (status: number, error: string, extra: Partial<Extract<EmergencyResult, { ok: false }>> = {}): EmergencyResult =>
  ({ ok: false, status, error, ...extra }) as EmergencyResult;

/** Per-op change-request risk. Quarantine is 'high' (matches kiosk transition risk). */
const OP_RISK: Record<EmergencyOp, ChangeRisk> = {
  suspend_device_credential: "high",
  quarantine_device: "high",
  pause_integration_feature: "medium",
  disable_ai_agent: "medium",
  maintenance_banner: "low",
};

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

/* ─── Op implementations (each assumes gates already passed) ────────────── */

async function opSuspendCredential(
  db: SupabaseClient,
  actor: SystemActor,
  deviceId: string,
): Promise<EmergencyResult> {
  if (!isUuid(deviceId)) return fail(400, "device_id must be a device uuid");
  const device = (await getDeviceAuthRow(db, deviceId)) as (DeviceAuthRow & { id: string }) | null;
  if (!device) return fail(404, "Device not found");
  const res = await revokeDeviceCredential(db, device, actor);
  if (!res.ok) return fail(res.status, res.error);
  return {
    ok: true, op: "suspend_device_credential",
    summary: `Credential revoked for device ${device.device_uid ?? device.id} (auth_method → none).`,
    expiresAt: null, changeRequestId: null,
  };
}

async function opQuarantineDevice(
  db: SupabaseClient,
  actor: SystemActor,
  input: EmergencyInput,
): Promise<EmergencyResult> {
  const deviceId = String(input.device_id ?? "");
  if (!isUuid(deviceId)) return fail(400, "device_id must be a device uuid");
  const device = (await getSystemDevice(db, deviceId)) as SystemDeviceRow | null;
  if (!device) return fail(404, "Device not found");
  const from = device.status;
  if (!isSystemDeviceStatus(from)) return fail(409, `Unknown device status '${from}'`);
  if (from === "quarantined") return fail(409, "Device is already quarantined");
  if (from === "decommissioned") return fail(409, "Decommissioned devices cannot be quarantined");
  const to: SystemDeviceStatus = "quarantined";
  if (!DEVICE_TRANSITIONS[from].includes(to)) {
    return fail(409, `Illegal transition ${from} → ${to} — use the device lifecycle controls instead`);
  }
  // Direct transition (same legality + audit contract as setDeviceStatus, but
  // keyed to the emergency change-request action so approval matching is exact).
  const approval = await assertApprovedOrRequest(db, actor, {
    action: `emergency.quarantine_device:${device.id}`,
    risk: transitionRisk(to),
    justification: input.reason,
  });
  if (approval.status === "pending") {
    return fail(202, "Change request created — awaiting approval", { pending: true, changeRequestId: approval.changeRequestId });
  }
  if (approval.status === "error") return fail(500, approval.error);

  const { error } = await db.from("system_devices").update({
    status: to,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id);
  if (error) return fail(500, error.message ?? "status update failed");
  await systemAudit(db, {
    actor,
    action: "kiosk.status_changed",
    resource: `system_device:${device.id}`,
    detail: { from, to, device_uid: device.device_uid, serial_number: device.serial_number, via: "emergency.quarantine_device", change_request_id: approval.changeRequestId },
  });
  return {
    ok: true, op: "quarantine_device",
    summary: `Device ${device.device_uid ?? device.id} quarantined (${from} → quarantined).`,
    expiresAt: null, changeRequestId: approval.changeRequestId,
  };
}

async function opPauseFeature(
  db: SupabaseClient,
  actor: SystemActor,
  flag: string,
): Promise<EmergencyResult> {
  const key = String(flag ?? "").trim();
  if (!EMERGENCY_PAUSABLE_FLAGS.includes(key)) {
    return fail(400, `Flag '${key}' is not pausable via emergency controls`, { code: "flag_not_allowed" });
  }
  const { data: existing, error: readErr } = await db
    .from("system_feature_flags")
    .select("key,enabled")
    .eq("key", key)
    .maybeSingle();
  if (readErr) return fail(500, readErr.message ?? "flag lookup failed");
  if (!existing) return fail(404, `Feature flag '${key}' does not exist`);
  if ((existing as { enabled?: boolean }).enabled === false) {
    return { ok: true, op: "pause_integration_feature", summary: `Flag '${key}' was already disabled.`, expiresAt: null, changeRequestId: null };
  }
  const res = await setFeatureFlag(db, actor, { key, enabled: false });
  if (!res.ok) return fail(res.status, res.error);
  return {
    ok: true, op: "pause_integration_feature",
    summary: `Feature flag '${key}' paused (metadata + audit; env vars still govern runtime).`,
    expiresAt: null, changeRequestId: null,
  };
}

async function opDisableAgent(
  db: SupabaseClient,
  actor: SystemActor,
  agentId: string,
  reason: string,
): Promise<EmergencyResult> {
  const id = String(agentId ?? "").trim();
  if (!AGENT_ID_RE.test(id)) return fail(400, "Invalid agent id");
  const agent = await getAgent(db, id);
  if (!agent) return fail(404, "Agent not found");
  if (!agent.enabled) {
    return { ok: true, op: "disable_ai_agent", summary: `Agent '${id}' was already disabled.`, expiresAt: null, changeRequestId: null };
  }
  const res = await setAgentKillState(db, actor, id, false, reason);
  if (!res.ok) return fail(res.status, res.error);
  return {
    ok: true, op: "disable_ai_agent",
    summary: `Agent '${id}' (${agent.name}) disabled.`,
    expiresAt: null, changeRequestId: null,
  };
}

async function opMaintenanceBanner(
  db: SupabaseClient,
  actor: SystemActor,
  input: EmergencyInput,
): Promise<EmergencyResult> {
  const enabled = input.banner_enabled === true;
  const nowIso = new Date().toISOString();

  if (!enabled) {
    const { error } = await db.from("system_feature_flags").upsert({
      key: MAINTENANCE_FLAG_KEY,
      environment: "production",
      enabled: false,
      description: "Site maintenance notice marker — cleared via emergency controls.",
      owner: "platform",
      prerequisites: [],
      updated_by: actor.id,
      updated_at: nowIso,
    }, { onConflict: "key" });
    if (error) return fail(500, error.message ?? "flag update failed");
    return {
      ok: true, op: "maintenance_banner",
      summary: "Maintenance notice cleared.",
      expiresAt: null, changeRequestId: null,
    };
  }

  const message = String(input.banner_message ?? "").trim();
  if (message.length < 10 || message.length > 280) {
    return fail(400, "banner_message must be 10–280 characters");
  }
  const minutes = Number.isInteger(input.banner_minutes)
    ? Math.min(Math.max(input.banner_minutes as number, BANNER_MIN_MINUTES), BANNER_MAX_MINUTES)
    : BANNER_DEFAULT_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

  const { error } = await db.from("system_feature_flags").upsert({
    key: MAINTENANCE_FLAG_KEY,
    environment: "production",
    enabled: true,
    description: `Maintenance notice: ${message.slice(0, 200)}`,
    owner: "platform",
    // prerequisites carries the TTL payload — flags have no dedicated expiry column.
    prerequisites: { expires_at: expiresAt, message: message.slice(0, 280), set_by: actor.id, set_at: nowIso },
    updated_by: actor.id,
    updated_at: nowIso,
  }, { onConflict: "key" });
  if (error) return fail(500, error.message ?? "flag update failed");
  return {
    ok: true, op: "maintenance_banner",
    summary: `Maintenance notice set — expires ${expiresAt} (${minutes} min). NOTE: flag rows are control-plane metadata; a public banner reader is not wired yet.`,
    expiresAt, changeRequestId: null,
  };
}

/* ─── Entry point ───────────────────────────────────────────────────────── */

/**
 * Executes one scoped emergency operation. Order of gates (all mandatory):
 *   1. backend configured
 *   2. op valid + confirm === op + reason ≥10 chars
 *   3. live step-up elevation (requireElevation — 403 step_up_required)
 *   4. change-request gate (breakglass / high|critical risk → 202 pending)
 *   5. typed mutation + audit
 */
export async function executeEmergencyOp(
  db: SupabaseClient | null | undefined,
  user: SessionUser | null,
  actor: SystemActor,
  input: EmergencyInput,
): Promise<EmergencyResult> {
  if (!db) return fail(503, "Backend not configured");
  if (!isEmergencyOp(input?.op)) return fail(400, "Unknown emergency operation");
  if (input.confirm !== input.op) {
    return fail(400, `confirm must be exactly '${input.op}'`, { code: "confirm_required" });
  }
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 2000) {
    return fail(400, "reason must be 10–2000 characters", { code: "reason_required" });
  }

  // Step-up elevation — ALWAYS, for every op.
  const elev = await requireElevation(db, user);
  if (!elev.ok) return fail(elev.status, elev.error, { code: elev.code });

  // Change-request gate — action string includes the op + target so an
  // approved request covers exactly one scoped action.
  const target =
    input.op === "suspend_device_credential" || input.op === "quarantine_device" ? String(input.device_id ?? "")
    : input.op === "pause_integration_feature" ? String(input.flag ?? "")
    : input.op === "disable_ai_agent" ? String(input.agent_id ?? "")
    : "-";
  const normalized: EmergencyInput = { ...input, reason };

  // quarantine_device runs its own approval inside opQuarantineDevice (it needs
  // the from→to transition risk, not the generic op risk) — skip the generic gate.
  let changeRequestId: string | null = null;
  if (input.op !== "quarantine_device") {
    const approval = await assertApprovedOrRequest(db, actor, {
      action: `emergency.${input.op}:${target}`,
      risk: OP_RISK[input.op],
      justification: reason,
    });
    if (approval.status === "pending") {
      return fail(202, "Change request created — awaiting approval", { pending: true, changeRequestId: approval.changeRequestId });
    }
    if (approval.status === "error") return fail(500, approval.error);
    changeRequestId = approval.changeRequestId;
  }

  let res: EmergencyResult;
  switch (input.op) {
    case "suspend_device_credential":
      res = await opSuspendCredential(db, actor, String(input.device_id ?? ""));
      break;
    case "quarantine_device":
      res = await opQuarantineDevice(db, actor, normalized);
      break;
    case "pause_integration_feature":
      res = await opPauseFeature(db, actor, String(input.flag ?? ""));
      break;
    case "disable_ai_agent":
      res = await opDisableAgent(db, actor, String(input.agent_id ?? ""), reason);
      break;
    case "maintenance_banner":
      res = await opMaintenanceBanner(db, actor, normalized);
      break;
    default:
      return fail(400, "Unknown emergency operation");
  }

  if (res.ok) {
    await systemAudit(db, {
      actor,
      action: `emergency.${input.op}`,
      resource: `emergency:${input.op}:${target === "-" ? "banner" : target}`.slice(0, 190),
      detail: {
        op: input.op,
        target: target === "-" ? null : target,
        reason,
        change_request_id: res.changeRequestId ?? changeRequestId,
        expires_at: res.expiresAt,
      },
    });
    return { ...res, changeRequestId: res.changeRequestId ?? changeRequestId };
  }
  return res;
}

export type EmergencyActionRow = {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource: string;
  detail: Record<string, unknown>;
  created_at: string;
};

/** Recent executed emergency ops from the append-only audit log (action 'emergency.%'). */
export async function listEmergencyActions(db: SupabaseClient | null, limit = 50): Promise<EmergencyActionRow[]> {
  if (!db) return [];
  const { data, error } = await db
    .from("system_audit_events")
    .select("id,actor_id,actor_role,action,resource,detail,created_at")
    .like("action", "emergency.%")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) return [];
  return ((data ?? []) as unknown as EmergencyActionRow[]).map((r) => ({
    ...r,
    detail: r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? r.detail : {},
  }));
}

export type MaintenanceNotice = { message: string; expiresAt: string } | null;

/**
 * Reads the maintenance.notice flag and returns the notice ONLY while it is
 * enabled and unexpired. Honest: returns null when the flag row is absent,
 * disabled, malformed, or past expires_at.
 */
export async function getMaintenanceNotice(db: SupabaseClient | null, nowMs = Date.now()): Promise<MaintenanceNotice> {
  if (!db) return null;
  const { data, error } = await db
    .from("system_feature_flags")
    .select("enabled,prerequisites")
    .eq("key", MAINTENANCE_FLAG_KEY)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { enabled?: boolean; prerequisites?: unknown };
  if (row.enabled !== true) return null;
  const p = row.prerequisites;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const { expires_at, message } = p as { expires_at?: unknown; message?: unknown };
  if (typeof expires_at !== "string" || typeof message !== "string" || !message.trim()) return null;
  const exp = Date.parse(expires_at);
  if (!Number.isFinite(exp) || exp <= nowMs) return null;
  return { message: message.slice(0, 280), expiresAt: expires_at };
}
