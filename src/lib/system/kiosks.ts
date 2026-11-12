import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { systemAudit, assertApprovedOrRequest, type ChangeRisk, type SystemActor } from "./audit";
import { getKioskAdapter } from "@/lib/kiosk/adapter";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { classifyReadiness, type ReadinessCheck } from "./hardware";

/**
 * Kiosk fleet registry helpers (system.zapnivo.com → KIOSK INFRASTRUCTURE).
 *
 * Backed by migration 0042 tables `system_devices` + `system_device_commands`.
 * These are SEPARATE from the rental-facing `kiosks`/`device_commands` tables —
 * nothing here claims a physical device is reachable. With KIOSK_ADAPTER=none
 * (NullKioskAdapter) every command is recorded honestly as failed/adapter_disabled
 * and no telemetry is ever fabricated.
 *
 * NOTE on permissions: SYSTEM_PERMISSIONS only defines system.kiosks.view and
 * system.kiosks.manage. Register/provision/status/commands/diagnostics-write all
 * require `manage`; diagnostics-read requires `view`. (A future
 * system.kiosks.register/.diagnostics split can be added to rbac.ts.)
 *
 * NOTE on command state: the system_device_commands.state CHECK constraint allows
 * only pending|sent|acked|failed|timeout|cancelled — there is no 'unsupported'
 * state and migrations are owned elsewhere. Unsupported commands are therefore
 * recorded as state='failed' with result.reason='adapter_disabled' /
 * 'adapter_unavailable', which is the honest terminal state (never 'sent').
 */

export const SYSTEM_DEVICE_STATUSES = [
  "pending", "registered", "provisioning", "testing", "active",
  "maintenance", "suspended", "quarantined", "decommissioned",
] as const;
export type SystemDeviceStatus = (typeof SYSTEM_DEVICE_STATUSES)[number];
export const isSystemDeviceStatus = (v: unknown): v is SystemDeviceStatus =>
  typeof v === "string" && (SYSTEM_DEVICE_STATUSES as readonly string[]).includes(v);

/** Allowed lifecycle edges. decommissioned is terminal. */
export const DEVICE_TRANSITIONS: Record<SystemDeviceStatus, readonly SystemDeviceStatus[]> = {
  pending: ["registered", "decommissioned"],
  registered: ["provisioning", "testing", "decommissioned"],
  provisioning: ["testing", "registered", "suspended", "decommissioned"],
  testing: ["active", "provisioning", "suspended", "decommissioned"],
  active: ["maintenance", "suspended", "quarantined", "decommissioned"],
  maintenance: ["active", "suspended", "quarantined", "decommissioned"],
  suspended: ["active", "provisioning", "quarantined", "decommissioned"],
  quarantined: ["suspended", "decommissioned"],
  decommissioned: [],
};

/** Targets that always require an approved change request (high risk). */
const HIGH_RISK_TARGETS: readonly SystemDeviceStatus[] = ["quarantined", "decommissioned"];
const MEDIUM_RISK_TARGETS: readonly SystemDeviceStatus[] = ["suspended"];

export function transitionRisk(to: SystemDeviceStatus): ChangeRisk {
  if (HIGH_RISK_TARGETS.includes(to)) return "high";
  if (MEDIUM_RISK_TARGETS.includes(to)) return "medium";
  return "low";
}

/** Status pill tones shared by fleet list + device detail (dark console palette). */
export const DEVICE_STATUS_TONE: Record<string, string> = {
  pending: "bg-white/10 text-slate-300 ring-white/15",
  registered: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  provisioning: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  testing: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  active: "bg-lime/15 text-lime ring-lime/30",
  maintenance: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  suspended: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  quarantined: "bg-red-500/15 text-red-300 ring-red-400/30",
  decommissioned: "bg-white/5 text-slate-500 ring-white/10",
};

export const deviceAuditResource = (deviceId: string) => `system_device:${deviceId}`;

export const SYSTEM_DEVICE_SELECT =
  "id,device_uid,serial_number,manufacturer,model,gateway,adapter_type,capabilities,slot_count,firmware_version,venue_id,region,status,provision_token_hash,provision_token_expires_at,provision_token_used_at,credential_rotated_at,installed_at,last_heartbeat_at,last_message_at,created_by,created_at,updated_at,auth_method,device_secret_hash,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts";

export type SystemDeviceRow = {
  id: string;
  device_uid: string | null;
  serial_number: string | null;
  manufacturer: string | null;
  model: string | null;
  gateway: string | null;
  adapter_type: string | null;
  capabilities: Record<string, unknown>;
  slot_count: number | null;
  firmware_version: string | null;
  venue_id: string | null;
  region: string | null;
  status: SystemDeviceStatus;
  provision_token_hash: string | null;
  provision_token_expires_at: string | null;
  provision_token_used_at: string | null;
  credential_rotated_at: string | null;
  installed_at: string | null;
  last_heartbeat_at: string | null;
  last_message_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Per-device ingest credential columns (migration 0044). device_secret_hash
  // stores sha256(secret) — the raw secret is never persisted.
  auth_method: string | null;
  device_secret_hash: string | null;
  credential_issued_at: string | null;
  credential_expires_at: string | null;
  credential_revoked_at: string | null;
  last_authed_at: string | null;
  last_message_ts: number | string | null;
};

export type VenueRef = { id: string; name: string | null; city: string | null } | null;
export type FleetDevice = SystemDeviceRow & { venue: VenueRef };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

/** Fleet list with venue name join. `status` must be a known device status. */
export async function listFleetDevices(
  db: SupabaseClient,
  opts: { status?: string; limit?: number } = {},
): Promise<{ devices: FleetDevice[]; error?: string }> {
  let q = db
    .from("system_devices")
    .select(`${SYSTEM_DEVICE_SELECT},venues(id,name,city)`)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  if (opts.status && isSystemDeviceStatus(opts.status)) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) return { devices: [], error: error.message };
  const devices = ((data ?? []) as (SystemDeviceRow & { venues: { id: string; name: string | null; city: string | null } | { id: string; name: string | null; city: string | null }[] | null })[])
    .map((d) => {
      const v = Array.isArray(d.venues) ? d.venues[0] ?? null : d.venues ?? null;
      const { venues: _drop, ...rest } = d as SystemDeviceRow & { venues?: unknown };
      return { ...rest, venue: v } as FleetDevice;
    });
  return { devices };
}

export async function getSystemDevice(db: SupabaseClient, id: string): Promise<SystemDeviceRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db.from("system_devices").select(SYSTEM_DEVICE_SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as SystemDeviceRow;
}

/* ── Registration ─────────────────────────────────────────────────────────── */

export const registerKioskSchema = z.object({
  serial_number: z.string().trim().min(1).max(120),
  manufacturer: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  gateway: z.string().trim().min(1).max(120),
  adapter_type: z.string().trim().min(1).max(60),
  slot_count: z.number().int().min(1).max(64),
  firmware_version: z.string().trim().max(60).optional(),
  venue_id: z.string().uuid().optional(),
  region: z.string().trim().max(60).optional(),
});
export type RegisterKioskInput = z.infer<typeof registerKioskSchema>;

const newDeviceUid = () => `kiosk-${randomBytes(6).toString("hex")}`;

/**
 * Inserts a system_devices row with status 'registered'. Honest failures:
 * duplicate serial → 409 (pre-check + unique-violation fallback), missing venue → 400.
 */
export async function registerKiosk(
  db: SupabaseClient,
  input: RegisterKioskInput,
  actor: SystemActor,
): Promise<{ ok: true; device: SystemDeviceRow } | { ok: false; status: number; error: string }> {
  if (input.venue_id) {
    const { data: venue } = await db.from("venues").select("id").eq("id", input.venue_id).maybeSingle();
    if (!venue) return { ok: false, status: 400, error: "venue_id does not match a known venue" };
  }
  const { data: dup } = await db.from("system_devices").select("id").eq("serial_number", input.serial_number).limit(1);
  if (dup && dup.length > 0) return { ok: false, status: 409, error: "A device with this serial_number is already registered" };

  // device_uid is unique; regenerate on the (astronomically rare) collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.from("system_devices").insert({
      device_uid: newDeviceUid(),
      serial_number: input.serial_number,
      manufacturer: input.manufacturer,
      model: input.model,
      gateway: input.gateway,
      adapter_type: input.adapter_type,
      slot_count: input.slot_count,
      firmware_version: input.firmware_version ?? null,
      venue_id: input.venue_id ?? null,
      region: input.region ?? null,
      status: "registered",
      created_by: actor.id,
    }).select(SYSTEM_DEVICE_SELECT).single();
    if (!error && data) {
      const device = data as SystemDeviceRow;
      await systemAudit(db, {
        actor, action: "kiosk.registered", resource: deviceAuditResource(device.id),
        detail: { device_uid: device.device_uid, serial_number: device.serial_number, model: device.model, venue_id: device.venue_id, slot_count: device.slot_count },
      });
      return { ok: true, device };
    }
    if (error?.code === "23505") {
      // Unique violation — could be serial (race) or uid (collision). Re-check serial.
      const { data: again } = await db.from("system_devices").select("id").eq("serial_number", input.serial_number).limit(1);
      if (again && again.length > 0) return { ok: false, status: 409, error: "A device with this serial_number is already registered" };
      continue; // uid collision → retry with a fresh uid
    }
    return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  }
  return { ok: false, status: 500, error: "Could not allocate a unique device_uid" };
}

/* ── Lifecycle transitions ────────────────────────────────────────────────── */

/**
 * Moves a device along DEVICE_TRANSITIONS. Illegal edges → 409. High/critical-risk
 * targets and breakglass actors go through assertApprovedOrRequest (change-request
 * flow); the mutation only runs when the gate returns 'approved'.
 */
export async function setDeviceStatus(
  db: SupabaseClient,
  device: SystemDeviceRow,
  to: SystemDeviceStatus,
  actor: SystemActor,
  justification?: string,
): Promise<
  | { ok: true; device: SystemDeviceRow }
  | { ok: false; status: number; error: string; pending?: boolean; changeRequestId?: string }
> {
  const from = device.status;
  if (from === to) return { ok: false, status: 409, error: `Device is already ${to}` };
  if (!DEVICE_TRANSITIONS[from].includes(to)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${to}` };
  }
  const risk = transitionRisk(to);
  const approval = await assertApprovedOrRequest(db, actor, {
    action: `kiosk.status.${from}_to_${to}`,
    risk,
    justification: justification?.trim() || `Transition kiosk ${device.device_uid ?? device.id} ${from} → ${to}`,
  });
  if (approval.status === "pending") {
    return { ok: false, status: 202, error: "Change request created — awaiting approval", pending: true, changeRequestId: approval.changeRequestId };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const patch: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() };
  if (to === "decommissioned") patch.credential_rotated_at = patch.credential_rotated_at ?? new Date().toISOString();
  const { data, error } = await db.from("system_devices").update(patch).eq("id", device.id).select(SYSTEM_DEVICE_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.status_changed", resource: deviceAuditResource(device.id),
    detail: { from, to, device_uid: device.device_uid, serial_number: device.serial_number, change_request_id: approval.changeRequestId },
  });
  return { ok: true, device: data as SystemDeviceRow };
}

/* ── Provisioning tokens ──────────────────────────────────────────────────── */

export const PROVISION_TOKEN_TTL_MS = 72 * 3600_000; // 72h

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Issues a single-use provisioning token. Returns the RAW token exactly once —
 * only its SHA-256 hash + 72h expiry are persisted. The token value is NEVER
 * written to audit detail or logs.
 *
 * FOLLOW-UP: /api/devices/events ingest still authenticates with the shared
 * KIOSK_INGEST_SECRET env secret, not per-device tokens (see
 * src/lib/kiosk/adapter-contract.ts DeviceAuthMethod). Per-device token
 * verification at ingest is a later stage; provision_token_used_at exists for it.
 */
export async function issueProvisionToken(
  db: SupabaseClient,
  device: SystemDeviceRow,
  actor: SystemActor,
): Promise<{ ok: true; token: string; expiresAt: string; device: SystemDeviceRow } | { ok: false; status: number; error: string }> {
  if (device.status === "decommissioned") return { ok: false, status: 409, error: "Cannot provision a decommissioned device" };
  const token = `znk_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + PROVISION_TOKEN_TTL_MS).toISOString();
  const { data, error } = await db.from("system_devices").update({
    provision_token_hash: sha256hex(token),
    provision_token_expires_at: expiresAt,
    provision_token_used_at: null, // new issuance resets single-use state
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(SYSTEM_DEVICE_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.provision_token_issued", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, serial_number: device.serial_number, expires_at: expiresAt, ttl_hours: 72 },
  });
  return { ok: true, token, expiresAt, device: data as SystemDeviceRow };
}

/** Revokes an issued-but-unused provisioning token (clears hash + expiry). */
export async function revokeProvisionToken(
  db: SupabaseClient,
  device: SystemDeviceRow,
  actor: SystemActor,
): Promise<{ ok: true; device: SystemDeviceRow } | { ok: false; status: number; error: string }> {
  if (!device.provision_token_hash && !device.provision_token_expires_at) {
    return { ok: false, status: 409, error: "No active provisioning token to revoke" };
  }
  const { data, error } = await db.from("system_devices").update({
    provision_token_hash: null,
    provision_token_expires_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", device.id).select(SYSTEM_DEVICE_SELECT).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "update failed" };
  await systemAudit(db, {
    actor, action: "kiosk.provision_token_revoked", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, serial_number: device.serial_number, was_used: !!device.provision_token_used_at },
  });
  return { ok: true, device: data as SystemDeviceRow };
}

/* ── Diagnostics ──────────────────────────────────────────────────────────── */

export const ADAPTER_NAMES = ["none", "simulator"] as const;

/**
 * Adapter name as configured. KIOSK_ADAPTER env is the intended selector
 * (currently only "none" is real — getKioskAdapter() always returns
 * NullKioskAdapter until a vendor adapter lands).
 */
export function kioskAdapterName(): string {
  const env = process.env.KIOSK_ADAPTER?.trim().toLowerCase();
  if (env && (ADAPTER_NAMES as readonly string[]).includes(env)) return env;
  return getKioskAdapter().name ?? "none";
}

export type DiagnosticCheck = { name: string; ok: boolean | null; detail: string };
export type DiagnosticResult = {
  status: "adapter_unavailable" | "simulated" | "no_heartbeat" | "ok_no_adapter";
  adapter: string;
  checked_at: string;
  checks: DiagnosticCheck[];
  heartbeat_age_minutes: number | null;
  /** Per-stage hardware-path readiness (api_reachable → hardware_confirmed). */
  readiness: ReadinessCheck[];
};

/**
 * Bounded, read-only diagnostics. NEVER performs a live network ping — with
 * adapter=none the only honest result is adapter_unavailable; heartbeat age is
 * reported from stored timestamps only.
 */
export async function runDeviceDiagnostics(db: SupabaseClient, device: SystemDeviceRow): Promise<DiagnosticResult> {
  const now = new Date();
  const adapter = kioskAdapterName();
  const heartbeatAgeMin = device.last_heartbeat_at
    ? Math.max(0, Math.round((now.getTime() - new Date(device.last_heartbeat_at).getTime()) / 60_000))
    : null;
  const checks: DiagnosticCheck[] = [
    { name: "registry_row", ok: true, detail: `system_devices row present (status=${device.status})` },
    {
      name: "last_heartbeat",
      ok: heartbeatAgeMin == null ? null : heartbeatAgeMin <= HEARTBEAT_STALE_MIN,
      detail: device.last_heartbeat_at
        ? `last heartbeat ${heartbeatAgeMin} min ago (stale threshold ${HEARTBEAT_STALE_MIN} min)`
        : "no heartbeat recorded — device has never reported",
    },
    { name: "last_message", ok: device.last_message_at != null ? true : null, detail: device.last_message_at ? `last message ${device.last_message_at}` : "no messages recorded" },
    {
      name: "adapter",
      ok: adapter === "none" ? false : null,
      detail: adapter === "none"
        ? "KIOSK_ADAPTER=none — NullKioskAdapter; no hardware path exists, live ping impossible"
        : `adapter configured as "${adapter}" (selection not yet wired to a real implementation)`,
    },
  ];
  const status: DiagnosticResult["status"] =
    adapter === "none" ? "adapter_unavailable"
    : adapter === "simulator" ? "simulated"
    : heartbeatAgeMin == null ? "no_heartbeat"
    : "ok_no_adapter";

  // Hardware-path readiness: a stage is 'verified' only from stored evidence.
  // 'hardware_confirmed' additionally requires a certified profile matching the
  // device's manufacturer+model (system_hardware_profiles, migration 0044 —
  // ops-managed, empty until real hardware is certified).
  let certifiedProfile = false;
  if (device.manufacturer && device.model) {
    const { data: prof } = await db.from("system_hardware_profiles")
      .select("id")
      .eq("manufacturer", device.manufacturer)
      .eq("model", device.model)
      .eq("certification_status", "certified")
      .limit(1);
    certifiedProfile = Array.isArray(prof) && prof.length > 0;
  }
  const readiness = classifyReadiness({ adapter, heartbeat_age_minutes: heartbeatAgeMin }, { certifiedProfile });

  return { status, adapter, checked_at: now.toISOString(), checks, heartbeat_age_minutes: heartbeatAgeMin, readiness };
}

/** Records a diagnostic run as a system_device_commands row (state='failed' — see header note). */
export async function recordDiagnosticPing(
  db: SupabaseClient,
  device: SystemDeviceRow,
  result: DiagnosticResult,
  actor: SystemActor,
) {
  const { data, error } = await db.from("system_device_commands").insert({
    device_id: device.id,
    command_type: "diagnostic_ping",
    payload: { adapter: result.adapter },
    state: "failed", // CHECK constraint has no 'unsupported'; failed+reason is the honest terminal state
    issued_by: actor.id,
    result: { reason: result.status === "adapter_unavailable" ? "adapter_unavailable" : "not_dispatched", status: result.status, adapter: result.adapter, heartbeat_age_minutes: result.heartbeat_age_minutes, detail: "No live ping performed — adapter not wired to hardware." },
  }).select("id,created_at").single();
  await systemAudit(db, {
    actor, action: "kiosk.diagnostics_run", resource: deviceAuditResource(device.id),
    detail: { device_uid: device.device_uid, status: result.status, adapter: result.adapter, heartbeat_age_minutes: result.heartbeat_age_minutes, command_id: data?.id ?? null },
  });
  if (error) return { recorded: false as const, commandId: null as string | null };
  return { recorded: true as const, commandId: (data as { id: string }).id };
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

/** Read-only command types that MAY be recorded. Everything else is rejected. */
export const ALLOWED_COMMAND_TYPES = ["status_request", "inventory_request", "firmware_version_request"] as const;
export type AllowedCommandType = (typeof ALLOWED_COMMAND_TYPES)[number];
export const isAllowedCommandType = (v: unknown): v is AllowedCommandType =>
  typeof v === "string" && (ALLOWED_COMMAND_TYPES as readonly string[]).includes(v);

export type DeviceCommandRow = {
  id: string;
  device_id: string;
  command_type: string;
  payload: Record<string, unknown>;
  state: string;
  idempotency_key: string | null;
  issued_by: string | null;
  result: Record<string, unknown> | null;
  timeout_at: string | null;
  acked_at: string | null;
  created_at: string;
};

export async function listDeviceCommands(db: SupabaseClient, deviceId: string, limit = 100): Promise<DeviceCommandRow[]> {
  const { data } = await db.from("system_device_commands")
    .select("id,device_id,command_type,payload,state,idempotency_key,issued_by,result,timeout_at,acked_at,created_at")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  return (data ?? []) as DeviceCommandRow[];
}

/**
 * Records a read-only command request. With no real adapter the command can never
 * be dispatched, so it is stored state='failed' result.reason='adapter_disabled' —
 * NEVER 'sent'/'acked'. Duplicate idempotency_key → 409 (unique constraint).
 */
export async function recordDeviceCommand(
  db: SupabaseClient,
  device: SystemDeviceRow,
  input: { commandType: AllowedCommandType; idempotencyKey: string; payload?: Record<string, unknown> },
  actor: SystemActor,
): Promise<{ ok: true; command: DeviceCommandRow } | { ok: false; status: number; error: string }> {
  const adapter = kioskAdapterName();
  const { data, error } = await db.from("system_device_commands").insert({
    device_id: device.id,
    command_type: input.commandType,
    payload: input.payload ?? {},
    state: "failed",
    idempotency_key: input.idempotencyKey,
    issued_by: actor.id,
    result: { reason: "adapter_disabled", adapter, detail: "Command recorded for audit only — KIOSK_ADAPTER has no live hardware path; nothing was dispatched." },
  }).select("id,device_id,command_type,payload,state,idempotency_key,issued_by,result,timeout_at,acked_at,created_at").single();
  if (error?.code === "23505") return { ok: false, status: 409, error: "Duplicate idempotency_key — command already recorded" };
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  const command = data as DeviceCommandRow;
  await systemAudit(db, {
    actor, action: "kiosk.command_recorded", resource: deviceAuditResource(device.id),
    detail: { command_id: command.id, command_type: input.commandType, state: command.state, reason: "adapter_disabled", idempotency_key: input.idempotencyKey },
  });
  return { ok: true, command };
}

/* ── Timeline & related data ──────────────────────────────────────────────── */

export type AuditEventRow = {
  id: string; actor_id: string | null; actor_role: string | null;
  action: string; resource: string; environment: string;
  detail: Record<string, unknown>; created_at: string;
};

export async function listDeviceAudit(db: SupabaseClient, deviceId: string, limit = 100): Promise<AuditEventRow[]> {
  const { data } = await db.from("system_audit_events")
    .select("id,actor_id,actor_role,action,resource,environment,detail,created_at")
    .eq("resource", deviceAuditResource(deviceId))
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));
  return (data ?? []) as AuditEventRow[];
}

export type RelatedKiosk = { id: string; station_id: string; state: string; model: string | null; last_seen_at: string | null };
export type RelatedRental = { id: string; reference: string | null; state: string; created_at: string; kiosk_station_id: string | null };

/**
 * Honest "related" data: system_devices has NO foreign key to the rental-facing
 * `kiosks` table. We can only match by shared venue_id — results are labeled as
 * venue-linked, never as a hard device↔station mapping.
 */
export async function listVenueLinkedKiosksAndRentals(
  db: SupabaseClient,
  venueId: string,
): Promise<{ kiosks: RelatedKiosk[]; rentals: RelatedRental[] }> {
  const { data: ks } = await db.from("kiosks")
    .select("id,station_id,state,model,last_seen_at")
    .eq("venue_id", venueId)
    .order("created_at", { ascending: false })
    .limit(50);
  const kiosks = (ks ?? []) as RelatedKiosk[];
  const kioskIds = kiosks.map((k) => k.id);
  let rentals: RelatedRental[] = [];
  if (kioskIds.length > 0) {
    const { data: rs } = await db.from("rentals")
      .select("id,reference,state,created_at,kiosk_id,kiosks(station_id)")
      .in("kiosk_id", kioskIds)
      .order("created_at", { ascending: false })
      .limit(50);
    rentals = ((rs ?? []) as (Omit<RelatedRental, "kiosk_station_id"> & { kiosk_id: string; kiosks: { station_id: string } | { station_id: string }[] | null })[])
      .map((r) => {
        const k = Array.isArray(r.kiosks) ? r.kiosks[0] : r.kiosks;
        const { kiosks: _drop, kiosk_id: _kid, ...rest } = r;
        return { ...rest, kiosk_station_id: k?.station_id ?? null } as RelatedRental;
      });
  }
  return { kiosks, rentals };
}

/* ── Derived connectivity (honest — no fabrication) ──────────────────────── */

export type Connectivity =
  | { kind: "no_data"; label: string }
  | { kind: "online" | "stale" | "offline"; label: string; ageMinutes: number | null };

export function deriveConnectivity(device: Pick<SystemDeviceRow, "last_heartbeat_at" | "last_message_at">, now = new Date()): Connectivity {
  if (!device.last_heartbeat_at) {
    return { kind: "no_data", label: "No heartbeat data — device has never reported" };
  }
  const t = new Date(device.last_heartbeat_at).getTime();
  if (!Number.isFinite(t)) return { kind: "no_data", label: "Heartbeat timestamp unparseable" };
  const ageMin = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (ageMin <= HEARTBEAT_STALE_MIN) return { kind: "online", label: `Heartbeat ${ageMin} min ago`, ageMinutes: ageMin };
  return { kind: "stale", label: `Last heartbeat ${ageMin} min ago (stale > ${HEARTBEAT_STALE_MIN} min)`, ageMinutes: ageMin };
}

/** Provisioning token state for display — never exposes the token value. */
export function provisionTokenState(device: Pick<SystemDeviceRow, "provision_token_hash" | "provision_token_expires_at" | "provision_token_used_at">, now = new Date()):
  | { state: "none" }
  | { state: "issued" | "expired" | "used"; expiresAt: string | null } {
  if (!device.provision_token_hash) return { state: "none" };
  if (device.provision_token_used_at) return { state: "used", expiresAt: device.provision_token_expires_at };
  const exp = device.provision_token_expires_at ? new Date(device.provision_token_expires_at).getTime() : null;
  if (exp != null && Number.isFinite(exp) && exp < now.getTime()) return { state: "expired", expiresAt: device.provision_token_expires_at };
  return { state: "issued", expiresAt: device.provision_token_expires_at };
}

export const randomIdempotencyKey = () => `cmd-${randomBytes(12).toString("hex")}`;
