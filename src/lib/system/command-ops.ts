import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMMAND_SELECT, OPEN_COMMAND_STATES, PHYSICAL_COMMANDS, REQUEUEABLE_STATES,
  requeueCommand, type CommandRow,
} from "@/lib/kiosk/commands";
import { DISPENSE_CONFIRM_TYPES, RETURN_EVENT_TYPES } from "@/lib/kiosk/lifecycle";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { resolveDeviceCapabilities, type DeviceCapabilitySource } from "@/lib/kiosk/capabilities";
import { requireElevation } from "./elevation";
import { systemAudit, type SystemActor } from "./audit";
import type { SessionUser } from "@/lib/auth";
import {
  SYSTEM_DEVICE_SELECT, isUuid, type SystemDeviceRow,
} from "./kiosks";

/**
 * Phase 2.6 — controlled command retries, command history, and the device ops
 * dashboard for the system console.
 *
 * SCOPE / HONESTY NOTES
 * ─────────────────────
 * `device_commands` (this module) is the rental-facing durable command queue —
 * rows are keyed by `kiosks.id`, NOT `system_devices.id`. The two registries are
 * bound the same way ingest binds them: `kiosks.station_id` equals
 * `system_devices.device_uid` OR `system_devices.serial_number`
 * (see src/app/api/devices/events/route.ts findStationDevice). All lookups here
 * go through that binding; a kiosk with no bound system_devices row is treated
 * as an unregistered/legacy station and physical commands fail closed.
 *
 * `system_device_commands` is the SEPARATE control-plane audit queue written by
 * src/lib/system/kiosks.ts — it is display-only here and is never requeued
 * through this module (its rows are recorded-failed audit entries, not a live
 * dispatch queue).
 *
 * Retry safety layers (defense in depth — the lib guard in commands.ts is the
 * last line, not the only one):
 *   1. permission          — enforced by the route (system.kiosks.manage)
 *   2. step-up elevation   — fresh MFA for PHYSICAL_COMMANDS (dispense |
 *                            return_slot | unlock_slot) via requireElevation
 *   3. operator confirm    — explicit confirm flag + reason ≥ 10 chars (route zod)
 *   4. device eligibility  — bound system_devices status ∈ {active, testing} and
 *                            credential not revoked; unbound kiosks must not be
 *                            'disabled', and physical retries additionally
 *                            require kiosk.state === 'online'
 *   5. capability check    — the bound device's RESOLVED capabilities
 *                            (system_devices.capabilities ∪ certified
 *                            system_hardware_profiles) must include the
 *                            command's required capability
 *   6. retry evidence      — dispense/return_slot retries that could release a
 *                            second power bank require either a clean prior
 *                            state with NO contradictory success ack in
 *                            device_events, or an explicit evidence_ref
 *                            (resolved/dismissed rental_exceptions id tied to
 *                            this command, or a device_events id showing the
 *                            previous attempt failed)
 *   7. lib state machine   — requeueCommand enforces REQUEUEABLE_STATES and
 *                            blocks unknown_outcome / requires_investigation;
 *                            each attempt gets a fresh `:rN` idempotency suffix
 *
 * No new commands are ever created here — requeue only re-queues an EXISTING
 * device_commands row. No credential material is read or returned.
 */

/* ── Command → capability map ─────────────────────────────────────────────── */

/**
 * Required ingest capability per command type, mapped onto the canonical
 * vocabulary in src/lib/kiosk/capabilities.ts (which maps EVENT types, not
 * commands — this is the honest command-side equivalent):
 *
 *   dispense      → "dispense"        (releases a power bank)
 *   return_slot   → "return_detect"   (accepts a returned bank into a slot)
 *   unlock_slot   → "dispense"        (physical slot actuation — same actuator
 *                                      class as a dispense; documented choice)
 *   reboot        → null              (device-management command; no ingest
 *                                      capability applies — gated by permission
 *                                      + recorded honestly)
 *   enable/disable→ null              (same — control-plane state commands)
 *
 * null = no capability gate. A required capability that the device cannot
 * resolve (no bound system_devices row, empty capabilities) fails CLOSED.
 */
export const COMMAND_REQUIRED_CAPABILITY: Readonly<Record<string, string | null>> = {
  dispense: "dispense",
  return_slot: "return_detect",
  unlock_slot: "dispense",
  reboot: null,
  enable: null,
  disable: null,
};

/** Commands whose retry could physically release/return hardware — evidence rule. */
export const DISPENSE_EVIDENCE_COMMANDS: ReadonlySet<string> = new Set(["dispense", "return_slot"]);

/** Device statuses eligible to receive (re)queued commands. */
export const COMMAND_ELIGIBLE_DEVICE_STATUSES: ReadonlySet<string> = new Set(["active", "testing"]);

/* ── Row shapes ───────────────────────────────────────────────────────────── */

export const OPS_KIOSK_SELECT =
  "id,station_id,state,venue_id,slot_count,last_seen_at,firmware_version,model,created_at";

export type OpsKiosk = {
  id: string; station_id: string | null; state: string;
  venue_id: string | null; slot_count: number | null;
  last_seen_at: string | null; firmware_version: string | null;
  model: string | null; created_at?: string | null;
};

export type BoundContext = {
  kiosk: OpsKiosk;
  /** Primary bound system_devices row (device_uid match preferred over serial). */
  systemDevice: SystemDeviceRow | null;
  /** ALL bound rows — >1 means ambiguous registry binding (reported, not hidden). */
  systemDevices: SystemDeviceRow[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCommandOpsUuid = isUuid;

const payloadStr = (payload: Record<string, unknown> | null | undefined, key: string) =>
  typeof payload?.[key] === "string" ? (payload[key] as string) : null;

async function getCommandRow(db: SupabaseClient, id: string): Promise<CommandRow | null> {
  if (!isUuid(id)) return null;
  const { data } = await db.from("device_commands").select(`${COMMAND_SELECT},issued_by`).eq("id", id).maybeSingle();
  return (data as CommandRow | null) ?? null;
}

async function getKioskRow(db: SupabaseClient, kioskId: string): Promise<OpsKiosk | null> {
  const { data } = await db.from("kiosks").select(OPS_KIOSK_SELECT).eq("id", kioskId).maybeSingle();
  return (data as OpsKiosk | null) ?? null;
}

/** system_devices rows bound to a station_id — device_uid match first, then serial. */
async function systemDevicesForStation(db: SupabaseClient, stationId: string): Promise<SystemDeviceRow[]> {
  if (!stationId) return [];
  const [byUid, bySerial] = await Promise.all([
    db.from("system_devices").select(SYSTEM_DEVICE_SELECT).eq("device_uid", stationId),
    db.from("system_devices").select(SYSTEM_DEVICE_SELECT).eq("serial_number", stationId),
  ]);
  const seen = new Set<string>();
  const out: SystemDeviceRow[] = [];
  for (const row of [...((byUid.data ?? []) as SystemDeviceRow[]), ...((bySerial.data ?? []) as SystemDeviceRow[])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  // device_uid matches are the canonical binding (provisioning sets it); serial is fallback.
  out.sort((a, b) => (a.device_uid === stationId ? 0 : 1) - (b.device_uid === stationId ? 0 : 1));
  return out;
}

/** kiosk → bound system device(s) via station_id ↔ device_uid/serial_number. */
export async function resolveBoundContext(db: SupabaseClient, kioskId: string): Promise<BoundContext | null> {
  const kiosk = await getKioskRow(db, kioskId);
  if (!kiosk) return null;
  const systemDevices = await systemDevicesForStation(db, kiosk.station_id ?? "");
  return { kiosk, systemDevice: systemDevices[0] ?? null, systemDevices };
}

/** system_devices row → rental-facing kiosk(s) bound to the same station_id. */
export async function kiosksForSystemDevice(db: SupabaseClient, device: Pick<SystemDeviceRow, "device_uid" | "serial_number">): Promise<OpsKiosk[]> {
  const ids = [device.device_uid, device.serial_number].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) return [];
  const { data } = await db.from("kiosks").select(OPS_KIOSK_SELECT).in("station_id", ids);
  return (data ?? []) as OpsKiosk[];
}

/* ── Payload sanitization ─────────────────────────────────────────────────── */

const SECRET_KEY_RE = /secret|token|signature|password|passwd|api[-_]?key|credential|cookie|otp|cvv|ssn|private|session|authorization|bearer|auth/i;

/**
 * Recursively strips credential/header-shaped keys from an arbitrary payload.
 * `idempotency_key`-style COLUMN values are never inside payload; payload keys
 * matching SECRET_KEY_RE are dropped entirely (value never returned).
 */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizePayload(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = sanitizePayload(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/* ── Command ↔ ack correlation ────────────────────────────────────────────── */

/**
 * The idempotency_key lineage for a command: the original key plus every
 * `:rN` requeue suffix. Acks correlate by command uuid (device_commands.id)
 * OR by whichever idempotency_key was live when the device saw the command.
 */
export function commandKeyLineage(cmd: Pick<CommandRow, "id" | "idempotency_key" | "attempt_count">): {
  commandId: string;
  baseKey: string;
  currentKey: string;
  allKeys: string[];
} {
  const currentKey = cmd.idempotency_key ?? "";
  const baseKey = currentKey.replace(/:r\d+$/, "");
  const attempt = Math.max(0, cmd.attempt_count ?? 0);
  const allKeys = attempt > 0
    ? [baseKey, ...Array.from({ length: attempt }, (_, i) => `${baseKey}:r${i + 1}`)]
    : [currentKey || baseKey];
  return { commandId: cmd.id, baseKey, currentKey, allKeys: [...new Set(allKeys.filter(Boolean))] };
}

/** Does a device-reported command_id correlate to THIS command row? */
export function commandCorrelationMatches(reported: unknown, cmd: Pick<CommandRow, "id" | "idempotency_key" | "attempt_count">): boolean {
  if (typeof reported !== "string" || !reported) return false;
  const lin = commandKeyLineage(cmd);
  if (reported === cmd.id) return true;
  if (lin.allKeys.includes(reported)) return true;
  // A key with an :rN suffix beyond the recorded attempt count still belongs
  // to this lineage (e.g. a retry raced the status write).
  if (lin.baseKey && reported.startsWith(`${lin.baseKey}:r`)) return true;
  return false;
}

/* ── Ack event classification (evidence) ──────────────────────────────────── */

const POSITIVE_ACK_TYPES = new Set([...DISPENSE_CONFIRM_TYPES, ...RETURN_EVENT_TYPES]);
const NEGATIVE_ACK_TYPES = new Set(["dispense_failed", "return_rejected"]);
const POSITIVE_OUTCOMES = new Set(["acknowledged", "released", "detected"]);
const NEGATIVE_OUTCOMES = new Set(["failed", "rejected"]);

type AckEventRow = {
  id: string | number; event_type: string; occurred_at: string | null;
  payload: Record<string, unknown> | null;
};

function classifyAckEvent(e: AckEventRow): "positive" | "negative" | "neutral" {
  const outcome = payloadStr(e.payload, "outcome");
  if (POSITIVE_ACK_TYPES.has(e.event_type) || (outcome && POSITIVE_OUTCOMES.has(outcome))) return "positive";
  if (NEGATIVE_ACK_TYPES.has(e.event_type) || (outcome && NEGATIVE_OUTCOMES.has(outcome))) return "negative";
  return "neutral";
}

async function correlatedAckEvents(db: SupabaseClient, cmd: CommandRow, limit = 300): Promise<AckEventRow[]> {
  const { data } = await db.from("device_events")
    .select("id,event_type,payload,occurred_at")
    .eq("kiosk_id", cmd.kiosk_id)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as AckEventRow[]).filter((e) =>
    commandCorrelationMatches(payloadStr(e.payload, "command_id"), cmd));
}

/* ── Retry evidence ───────────────────────────────────────────────────────── */

export type EvidenceResolution =
  | { ok: true; kind: "rental_exception" | "device_event"; id: string; detail: string }
  | { ok: false };

/**
 * Validates an operator-supplied evidence_ref for a dispense/return_slot retry.
 * Accepted forms:
 *   - rental_exceptions UUID — must exist, belong to this kiosk (or carry this
 *     command_id), and be status 'resolved' or 'dismissed' (a human already
 *     reviewed the ambiguous outcome).
 *   - device_events id (numeric) — must be an event on THIS kiosk that
 *     classifies as a FAILURE ack for this command (proof the previous attempt
 *     did not complete).
 * Anything else → { ok:false } → caller returns 409 insufficient_evidence.
 */
export async function resolveEvidenceRef(
  db: SupabaseClient, cmd: CommandRow, evidenceRef: string,
): Promise<EvidenceResolution> {
  const ref = evidenceRef.trim();
  if (!ref || ref.length > 120) return { ok: false };

  if (UUID_RE.test(ref)) {
    const { data } = await db.from("rental_exceptions")
      .select("id,kiosk_id,status,detail").eq("id", ref).maybeSingle();
    const ex = data as { id: string; kiosk_id: string | null; status: string; detail: Record<string, unknown> | null } | null;
    if (!ex) return { ok: false };
    if (ex.kiosk_id && ex.kiosk_id !== cmd.kiosk_id) return { ok: false };
    if (ex.status !== "resolved" && ex.status !== "dismissed") return { ok: false };
    const detailCmd = payloadStr(ex.detail, "command_id");
    // A resolved exception that names a DIFFERENT command is not evidence here.
    if (detailCmd && !commandCorrelationMatches(detailCmd, cmd)) return { ok: false };
    return { ok: true, kind: "rental_exception", id: ex.id, detail: `exception ${ex.status}` };
  }

  if (/^\d{1,20}$/.test(ref)) {
    const events = await correlatedAckEvents(db, cmd, 500);
    const ev = events.find((e) => String(e.id) === ref);
    if (!ev) return { ok: false };
    if (classifyAckEvent(ev) !== "negative") return { ok: false };
    return { ok: true, kind: "device_event", id: String(ev.id), detail: `failure ack ${ev.event_type}` };
  }

  return { ok: false };
}

export type RetryEvidence =
  | { ok: true; contradictory: boolean; evidence: EvidenceResolution | null; positiveAcks: number; negativeAcks: number; simulatedAcks: number }
  | { ok: false; status: 409; code: "insufficient_evidence"; error: string };

/**
 * Phase 2.6 evidence gate for dispense/return_slot retries.
 *
 * A retry of a physical release command could dispense a SECOND power bank if
 * the previous attempt actually completed but its ack was lost. Rules:
 *
 *   - Non-evidence commands (reboot/enable/disable/unlock_slot) → pass.
 *   - Prior state is already constrained to REQUEUEABLE_STATES by the caller.
 *     'failed' | 'cancelled' | 'expired' are definitive non-completions — they
 *     pass on prior state alone WHEN no contradictory ack exists.
 *   - 'timeout' is NOT definitive: the command was dispatched and the outcome
 *     is unknown — it is treated as ambiguous and requires evidence_ref even
 *     without a recorded positive ack (stricter than the minimum spec; a lost
 *     ack is not proof the bank stayed put).
 *   - A POSITIVE ack correlated to this command in device_events is
 *     contradictory evidence the hardware acted → evidence_ref required.
 *   - evidence_ref must resolve (resolved/dismissed rental_exceptions id tied
 *     to this command, or a device_events id showing the attempt failed).
 *
 * Simulated acks (payload.simulated === true) still count as contradictory —
 * they are counted separately so audit can see the signal was synthetic.
 */
export async function assertRetryEvidence(
  db: SupabaseClient, cmd: CommandRow, evidenceRef?: string | null,
): Promise<RetryEvidence> {
  if (!DISPENSE_EVIDENCE_COMMANDS.has(cmd.command)) {
    return { ok: true, contradictory: false, evidence: null, positiveAcks: 0, negativeAcks: 0, simulatedAcks: 0 };
  }
  const events = await correlatedAckEvents(db, cmd);
  let positive = 0, negative = 0, simulated = 0;
  for (const e of events) {
    if (e.payload?.simulated === true) simulated += 1;
    const c = classifyAckEvent(e);
    if (c === "positive") positive += 1;
    else if (c === "negative") negative += 1;
  }
  const contradictory = positive > 0;
  // 'timeout' = dispatched, outcome unknown → ambiguous even without a recorded ack.
  const needsEvidence = contradictory || cmd.status === "timeout";
  if (!needsEvidence) {
    return { ok: true, contradictory: false, evidence: null, positiveAcks: positive, negativeAcks: negative, simulatedAcks: simulated };
  }
  if (!evidenceRef) {
    return {
      ok: false, status: 409, code: "insufficient_evidence",
      error: contradictory
        ? "A previous attempt may have completed (positive ack recorded). Supply evidence_ref — a resolved rental_exceptions id for this command, or a device_events id showing the attempt failed — before retrying."
        : "This dispense/return attempt timed out — the outcome is unknown and a retry could release a second power bank. Supply evidence_ref proving the previous attempt did not complete.",
    };
  }
  const resolved = await resolveEvidenceRef(db, cmd, evidenceRef);
  if (!resolved.ok) {
    return {
      ok: false, status: 409, code: "insufficient_evidence",
      error: "evidence_ref did not resolve to a reviewed exception or a failure ack for this command.",
    };
  }
  return { ok: true, contradictory, evidence: resolved, positiveAcks: positive, negativeAcks: negative, simulatedAcks: simulated };
}

/* ── Eligibility + capability ─────────────────────────────────────────────── */

export type OpsCheck =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

/**
 * Device eligibility for (re)queueing a command. Bound system_devices rows are
 * authoritative: status must be active|testing and the ingest credential must
 * not be revoked. Unbound kiosks (no system_devices row) fall back to the
 * rental-facing kiosk.state — 'disabled' always denies; PHYSICAL commands
 * additionally require 'online' because there is no registry record proving
 * the hardware path is live.
 */
export async function assertDeviceEligible(bound: BoundContext, command: string): Promise<OpsCheck> {
  // A disabled rental-facing kiosk never receives commands, bound device or not.
  if (bound.kiosk.state === "disabled") {
    return { ok: false, status: 409, code: "device_not_eligible", error: "Kiosk is disabled." };
  }
  const device = bound.systemDevice;
  if (device) {
    if (!COMMAND_ELIGIBLE_DEVICE_STATUSES.has(device.status)) {
      return { ok: false, status: 409, code: "device_not_eligible", error: `Device status "${device.status}" cannot receive commands (requires active|testing).` };
    }
    if (device.credential_revoked_at) {
      return { ok: false, status: 409, code: "credential_revoked", error: "Device ingest credential is revoked — commands cannot be verified as delivered." };
    }
    return { ok: true };
  }
  if (PHYSICAL_COMMANDS.has(command) && bound.kiosk.state !== "online") {
    return { ok: false, status: 409, code: "device_not_eligible", error: `No bound system_devices row and kiosk state is "${bound.kiosk.state}" — physical retries require an online, registered device.` };
  }
  return { ok: true };
}

/**
 * Capability gate: the command's required capability (COMMAND_REQUIRED_CAPABILITY)
 * must be in the device's RESOLVED capability set (stored record ∪ certified
 * hardware profile — never device self-report). Commands with a null mapping
 * have no capability requirement.
 */
export async function assertCommandCapability(db: SupabaseClient, bound: BoundContext, command: string): Promise<OpsCheck> {
  const required = COMMAND_REQUIRED_CAPABILITY[command];
  if (required == null) return { ok: true };
  const source: DeviceCapabilitySource = bound.systemDevice
    ? {
        capabilities: bound.systemDevice.capabilities,
        manufacturer: bound.systemDevice.manufacturer,
        model: bound.systemDevice.model,
      }
    : null;
  const caps = await resolveDeviceCapabilities(db, source);
  if (!caps.has(required)) {
    return {
      ok: false, status: 409, code: "capability_not_supported",
      error: `Device does not hold the "${required}" capability required for "${command}".`,
    };
  }
  return { ok: true };
}

/* ── Requeue orchestration ────────────────────────────────────────────────── */

export type RequeueOpsInput = {
  /** Session user performing the retry (elevation is checked against this id). */
  user: SessionUser;
  actor: SystemActor;
  /** Operator justification — route enforces ≥10 chars; re-checked here. */
  reason: string;
  allowPhysical?: boolean;
  evidenceRef?: string | null;
  now?: Date;
};

export type RequeueOpsResult =
  | {
      ok: true; id: string; attempt: number; command: string; status: string;
      kiosk_id: string; device_id: string | null; evidence: EvidenceResolution | null;
      contradictory_ack: boolean;
    }
  | { ok: false; status: number; code: string; error: string };

const fail = (status: number, code: string, error: string): RequeueOpsResult => ({ ok: false, status, code, error });

/**
 * Controlled requeue of an EXISTING device_commands row. Never creates commands,
 * never accepts new payloads — the retried command carries its original payload.
 * Every gate failure is a typed { ok:false } so the route maps codes → HTTP.
 */
export async function requeueDeviceCommand(
  db: SupabaseClient, commandId: string, input: RequeueOpsInput,
): Promise<RequeueOpsResult> {
  const reason = input.reason.trim();
  if (reason.length < 10) return fail(400, "reason_required", "A retry reason of at least 10 characters is required.");

  const cmd = await getCommandRow(db, commandId);
  if (!cmd) return fail(404, "not_found", "Command not found");

  // 1. Fresh step-up elevation for physical actuation — BEFORE any state change.
  if (PHYSICAL_COMMANDS.has(cmd.command)) {
    const elev = await requireElevation(db, input.user);
    if (!elev.ok) return fail(elev.status, elev.code ?? "step_up_required", elev.error);
  }

  // 2. State gate up-front for clear error codes (lib re-checks at write time).
  if (cmd.status === "unknown_outcome" || cmd.status === "requires_investigation") {
    return fail(409, "requires_investigation_escalation",
      `Command is ${cmd.status} — a human must resolve the investigation before any retry.`);
  }
  if (!REQUEUEABLE_STATES.has(cmd.status)) {
    return fail(409, "illegal_state", `Command status "${cmd.status}" cannot be requeued.`);
  }

  // 3. Bound device + eligibility.
  const bound = await resolveBoundContext(db, cmd.kiosk_id);
  if (!bound) return fail(404, "device_not_found", "The kiosk this command targets no longer exists.");
  const eligible = await assertDeviceEligible(bound, cmd.command);
  if (!eligible.ok) return fail(eligible.status, eligible.code, eligible.error);

  // 4. Capability verification.
  const capable = await assertCommandCapability(db, bound, cmd.command);
  if (!capable.ok) return fail(capable.status, capable.code, capable.error);

  // 5. Dispense/return evidence gate.
  const evidence = await assertRetryEvidence(db, cmd, input.evidenceRef ?? null);
  if (!evidence.ok) return fail(evidence.status, evidence.code, evidence.error);

  // 6. The guarded lib requeue — allowPhysical is the explicit staff opt-in for
  //    physical commands; each attempt gets a fresh :rN idempotency suffix.
  const res = await requeueCommand(db, cmd.id, {
    issuedBy: input.actor.id,
    allowPhysical: input.allowPhysical === true,
    now: input.now,
  });
  if (!res.ok) {
    const map: Record<string, { status: number; code: string }> = {
      not_found: { status: 404, code: "not_found" },
      physical_requires_review: { status: 409, code: "physical_requires_review" },
      requires_investigation: { status: 409, code: "requires_investigation_escalation" },
      illegal_transition: { status: 409, code: "illegal_state" },
      idempotency_conflict: { status: 409, code: "idempotency_conflict" },
    };
    const m = map[res.reason] ?? { status: 500, code: "requeue_failed" };
    return fail(m.status, m.code, `Requeue refused: ${res.reason}`);
  }

  // 7. System-plane audit (resource convention device_command:<id>).
  await systemAudit(db, {
    actor: input.actor,
    action: "kiosk.command_requeued",
    resource: `device_command:${cmd.id}`,
    detail: {
      command_id: cmd.id, command: cmd.command, kiosk_id: cmd.kiosk_id,
      device_id: bound.systemDevice?.id ?? null,
      attempt: res.attempt, from_status: cmd.status,
      reason: reason.slice(0, 500),
      allow_physical: input.allowPhysical === true,
      evidence_kind: evidence.evidence && evidence.evidence.ok ? evidence.evidence.kind : null,
      evidence_ref: input.evidenceRef ?? null,
      contradictory_ack: evidence.ok ? evidence.contradictory : null,
      positive_acks: evidence.ok ? evidence.positiveAcks : null,
      simulated_acks: evidence.ok ? evidence.simulatedAcks : null,
      bound_device_count: bound.systemDevices.length,
    },
  });

  return {
    ok: true, id: cmd.id, attempt: res.attempt, command: cmd.command, status: "queued",
    kiosk_id: cmd.kiosk_id, device_id: bound.systemDevice?.id ?? null,
    evidence: evidence.ok ? evidence.evidence : null,
    contradictory_ack: evidence.ok ? evidence.contradictory : false,
  };
}

/* ── Command history ──────────────────────────────────────────────────────── */

export type CommandHistoryFilters = {
  kioskId?: string | null;
  /** system_devices id — resolved to bound kiosk(s); unbound → empty result. */
  deviceId?: string | null;
  command?: string | null;
  state?: string | null;
  issuedBy?: string | null;
  from?: string | null;
  to?: string | null;
  /** Rental UUID or public reference — matched against payload.rental_id/_ref. */
  rental?: string | null;
  /** 'open' → only commands with an open/investigating rental_exception. */
  exception?: string | null;
  limit?: number;
};

export type CommandSummary = {
  id: string; kiosk_id: string; command: string; status: string;
  idempotency_key: string; attempt_count: number;
  created_at: string | null; resolved_at: string | null; expires_at: string | null;
  last_transition_at: string | null; resolved_outcome: string | null;
  expected_response_types: string[] | null;
  payload: unknown; // sanitized
  rental_ref: string | null;
  issued_by: string | null;
  /** True when an open/investigating rental_exception names this command. */
  open_exception: boolean;
};

export type CommandHistoryResult = {
  commands: CommandSummary[];
  /** Kiosk ids the query was scoped to (after device_id resolution). */
  kiosk_ids: string[];
  /** True when device_id was given but no kiosk binds to it. */
  unbound_device: boolean;
};

async function resolveRentalFilter(db: SupabaseClient, ref: string): Promise<{ id: string; reference: string | null } | null> {
  const { data: byId } = await db.from("rentals").select("id,reference").eq("id", ref).maybeSingle();
  if (byId) return byId as { id: string; reference: string | null };
  const { data: byRef } = await db.from("rentals").select("id,reference").eq("reference", ref).maybeSingle();
  return (byRef as { id: string; reference: string | null } | null) ?? null;
}

/** Open/investigating exception command_ids for a set of kiosks (JS match on detail). */
async function openExceptionCommandIds(db: SupabaseClient, kioskIds: string[]): Promise<Set<string>> {
  if (kioskIds.length === 0) return new Set();
  const { data } = await db.from("rental_exceptions")
    .select("kiosk_id,status,detail")
    .in("kiosk_id", kioskIds)
    .in("status", ["open", "investigating"])
    .limit(500);
  const out = new Set<string>();
  for (const r of (data ?? []) as { detail: Record<string, unknown> | null }[]) {
    const cid = payloadStr(r.detail, "command_id");
    if (cid) out.add(cid);
  }
  return out;
}

function toSummary(cmd: CommandRow, exceptionIds: Set<string>): CommandSummary {
  return {
    id: cmd.id, kiosk_id: cmd.kiosk_id, command: cmd.command, status: cmd.status,
    idempotency_key: cmd.idempotency_key, attempt_count: cmd.attempt_count ?? 0,
    created_at: cmd.created_at ?? null, resolved_at: cmd.resolved_at ?? null,
    expires_at: cmd.expires_at ?? null, last_transition_at: cmd.last_transition_at ?? null,
    resolved_outcome: cmd.resolved_outcome ?? null,
    expected_response_types: cmd.expected_response_types ?? null,
    payload: sanitizePayload(cmd.payload ?? null),
    rental_ref: payloadStr(cmd.payload, "rental_id") ?? payloadStr(cmd.payload, "rental_ref"),
    issued_by: (cmd as CommandRow & { issued_by?: string | null }).issued_by ?? null,
    open_exception: exceptionIds.has(cmd.id),
  };
}

/**
 * Filterable command history across the fleet. DB-side filters: kiosk scope,
 * command type, state, issued_by, created_at range. Payload-level filters
 * (rental ref, open exception) are applied in JS over a bounded window —
 * documented, never silently dropped.
 */
export async function listCommandHistory(db: SupabaseClient, f: CommandHistoryFilters): Promise<CommandHistoryResult> {
  // Resolve scope: explicit kiosk_id wins; device_id resolves via station binding;
  // neither → fleet-wide (kioskIds stays empty = no kiosk filter applied).
  let kioskIds: string[] = [];
  let unbound = false;
  if (f.kioskId) {
    if (!isUuid(f.kioskId)) return { commands: [], kiosk_ids: [], unbound_device: false };
    kioskIds = [f.kioskId];
  } else if (f.deviceId) {
    if (!isUuid(f.deviceId)) return { commands: [], kiosk_ids: [], unbound_device: true };
    const { data: dev } = await db.from("system_devices")
      .select("device_uid,serial_number").eq("id", f.deviceId).maybeSingle();
    const d = dev as { device_uid: string | null; serial_number: string | null } | null;
    if (!d) return { commands: [], kiosk_ids: [], unbound_device: true };
    const ks = await kiosksForSystemDevice(db, d);
    kioskIds = ks.map((k) => k.id);
    unbound = kioskIds.length === 0;
    if (unbound) return { commands: [], kiosk_ids: [], unbound_device: true };
  }

  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
  // issued_by is selected for display even though COMMAND_SELECT omits it.
  let q = db.from("device_commands").select(`${COMMAND_SELECT},issued_by`)
    .order("created_at", { ascending: false }).limit(limit);
  if (kioskIds.length > 0) q = q.in("kiosk_id", kioskIds);
  if (f.command) q = q.eq("command", f.command.slice(0, 60));
  if (f.state) q = q.eq("status", f.state.slice(0, 40));
  if (f.issuedBy && isUuid(f.issuedBy)) q = q.eq("issued_by", f.issuedBy);
  if (f.from) q = q.gte("created_at", f.from);
  if (f.to) q = q.lte("created_at", f.to);
  const { data, error } = await q;
  if (error) throw new Error(`command_history_failed: ${error.message}`);
  let rows = (data ?? []) as CommandRow[];

  // JS post-filters (payload jsonb + cross-table exception linkage).
  const wantException = f.exception === "open";
  let exceptionIds = new Set<string>();
  if (wantException) exceptionIds = await openExceptionCommandIds(db, rows.map((r) => r.kiosk_id));

  let rentalId: string | null = null;
  let rentalRefMatch: string | null = null;
  let rentalReference: string | null = null;
  if (f.rental) {
    const r = await resolveRentalFilter(db, f.rental.trim());
    rentalId = r?.id ?? null;
    rentalReference = r?.reference ?? null;
    rentalRefMatch = f.rental.trim();
  }

  const summaries = rows
    .filter((c) => {
      if (wantException && !exceptionIds.has(c.id)) return false;
      if (f.rental) {
        const rid = payloadStr(c.payload, "rental_id");
        const rref = payloadStr(c.payload, "rental_ref");
        const hit = (rentalId && (rid === rentalId || rref === rentalId))
          || rid === rentalRefMatch || rref === rentalRefMatch
          || (rentalReference && (rid === rentalReference || rref === rentalReference));
        if (!hit) return false;
      }
      return true;
    })
    .map((c) => toSummary(c, exceptionIds));

  return { commands: summaries, kiosk_ids: kioskIds, unbound_device: unbound };
}

/* ── Command detail ───────────────────────────────────────────────────────── */

export type CommandAckEvent = {
  id: string; event_type: string; occurred_at: string | null;
  outcome: string | null; error_code: string | null; simulated: boolean;
  classification: "positive" | "negative" | "neutral";
};

export type CommandDetail = {
  command: CommandSummary & { payload: unknown };
  kiosk: OpsKiosk | null;
  system_device: Pick<SystemDeviceRow, "id" | "device_uid" | "serial_number" | "status"> | null;
  bound_device_count: number;
  ack_events: CommandAckEvent[];
  retry: { attempt_count: number; idempotency_keys: string[]; requeueable: boolean };
  rental: { id: string; reference: string | null; state: string } | null;
  exceptions: { id: string; kind: string; status: string; created_at: string }[];
  audit_events: { id: string; source: "system" | "kiosk_log"; action: string; actor_id: string | null; actor_role: string | null; detail: unknown; created_at: string }[];
};

/** Full detail for one device_commands row — sanitized, correlated, audited. */
export async function getCommandDetail(db: SupabaseClient, commandId: string): Promise<CommandDetail | null> {
  const cmd = await getCommandRow(db, commandId);
  if (!cmd) return null;

  const [bound, ackRows, auditSys, auditKiosk, exceptionsRaw] = await Promise.all([
    resolveBoundContext(db, cmd.kiosk_id),
    correlatedAckEvents(db, cmd, 100),
    db.from("system_audit_events")
      .select("id,actor_id,actor_role,action,detail,created_at")
      .eq("resource", `device_command:${cmd.id}`)
      .order("created_at", { ascending: false }).limit(50),
    db.from("audit_logs")
      .select("id,actor,action,entity,entity_id,detail,occurred_at")
      .eq("entity", "kiosk").eq("entity_id", cmd.kiosk_id)
      .order("occurred_at", { ascending: false }).limit(200),
    db.from("rental_exceptions")
      .select("id,kind,status,created_at,detail")
      .eq("kiosk_id", cmd.kiosk_id).limit(200),
  ]);

  const ackEvents: CommandAckEvent[] = ackRows.map((e) => ({
    id: String(e.id),
    event_type: e.event_type,
    occurred_at: e.occurred_at ?? null,
    outcome: payloadStr(e.payload, "outcome"),
    error_code: payloadStr(e.payload, "error_code"),
    simulated: e.payload?.simulated === true,
    classification: classifyAckEvent(e),
  }));

  const kioskAudit = ((auditKiosk.data ?? []) as { id: string | number; actor: unknown; action: string; detail: Record<string, unknown> | null; occurred_at: string }[])
    .filter((a) => payloadStr(a.detail, "command_id") === cmd.id)
    .map((a) => ({
      id: String(a.id), source: "kiosk_log" as const, action: a.action,
      actor_id: typeof a.actor === "string" ? a.actor : null, actor_role: null,
      detail: sanitizePayload(a.detail ?? null), created_at: a.occurred_at,
    }));
  const sysAudit = ((auditSys.data ?? []) as { id: string; actor_id: string | null; actor_role: string | null; action: string; detail: unknown; created_at: string }[])
    .map((a) => ({ id: a.id, source: "system" as const, action: a.action, actor_id: a.actor_id, actor_role: a.actor_role, detail: sanitizePayload(a.detail ?? null), created_at: a.created_at }));

  const exceptions = ((exceptionsRaw.data ?? []) as { id: string; kind: string; status: string; created_at: string; detail: Record<string, unknown> | null }[])
    .filter((x) => {
      const cid = payloadStr(x.detail, "command_id");
      return cid ? commandCorrelationMatches(cid, cmd) : false;
    })
    .map((x) => ({ id: x.id, kind: x.kind, status: x.status, created_at: x.created_at }));

  // Rental link from payload (rental_id uuid or rental_ref public reference).
  let rental: CommandDetail["rental"] = null;
  const rentalRef = payloadStr(cmd.payload, "rental_id") ?? payloadStr(cmd.payload, "rental_ref");
  if (rentalRef) {
    const { data } = await db.from("rentals").select("id,reference,state").eq("id", rentalRef).maybeSingle();
    let r = (data as { id: string; reference: string | null; state: string } | null) ?? null;
    if (!r) {
      const { data: byRef } = await db.from("rentals").select("id,reference,state").eq("reference", rentalRef).maybeSingle();
      r = (byRef as { id: string; reference: string | null; state: string } | null) ?? null;
    }
    rental = r;
  }

  const lin = commandKeyLineage(cmd);
  const device = bound?.systemDevice ?? null;
  return {
    command: { ...toSummary(cmd, new Set()), payload: sanitizePayload(cmd.payload ?? null) },
    kiosk: bound?.kiosk ?? null,
    system_device: device ? { id: device.id, device_uid: device.device_uid, serial_number: device.serial_number, status: device.status } : null,
    bound_device_count: bound?.systemDevices.length ?? 0,
    ack_events: ackEvents,
    retry: {
      attempt_count: cmd.attempt_count ?? 0,
      idempotency_keys: lin.allKeys,
      requeueable: REQUEUEABLE_STATES.has(cmd.status),
    },
    rental,
    exceptions,
    audit_events: [...sysAudit, ...kioskAudit]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  };
}

/* ── Device ops dashboard ─────────────────────────────────────────────────── */

export type OpsDashboard = {
  bound_kiosks: OpsKiosk[];
  /** True when no rental-facing kiosk binds to this device — queue N/A. */
  unbound: boolean;
  commands: {
    open: CommandSummary[];
    recent: CommandSummary[];
    counts: { open: number; failed: number; unknown_or_investigation: number; total: number };
  };
  hardware_events: {
    id: string; kiosk_id: string; event_type: string; occurred_at: string | null;
    outcome: string | null; error_code: string | null; simulated: boolean;
  }[];
  exceptions: { id: string; kind: string; status: string; created_at: string; kiosk_id: string | null }[];
  inventory: {
    kiosks: { id: string; station_id: string | null; slot_count: number | null }[];
    slots_by_state: Record<string, number>;
    power_banks: { total: number; docked: number; retired: number };
  };
  maintenance: { id: string; kiosk_id: string; technician: string | null; notes: string | null; visited_at: string | null }[];
  certification: {
    physical_latest: { id: string; check_key: string; status: string; created_at: string } | null;
    runs_by_tier: Record<string, number>;
  };
  /** Honest verification signals — each derived only from stored evidence. */
  verification: {
    gateway_reachable: { state: "unverifiable" | "unknown"; detail: string };
    heartbeat_received: { state: "yes" | "no" | "stale"; last_at: string | null; detail: string };
    ack_received: { state: "yes" | "no"; last_at: string | null; detail: string };
    simulated_evidence: { state: "yes" | "no"; detail: string };
    physically_verified: { state: "yes" | "no" | "partial"; detail: string };
  };
};

/**
 * Assembles the device ops dashboard for a system_devices row. Every section
 * tolerates missing tables/rows and labels provenance honestly — nothing here
 * claims live hardware contact.
 */
export async function getDeviceOpsDashboard(db: SupabaseClient, device: SystemDeviceRow, now = new Date()): Promise<OpsDashboard> {
  const kiosks = await kiosksForSystemDevice(db, device);
  const kioskIds = kiosks.map((k) => k.id);
  const empty: OpsDashboard = {
    bound_kiosks: kiosks, unbound: kioskIds.length === 0,
    commands: { open: [], recent: [], counts: { open: 0, failed: 0, unknown_or_investigation: 0, total: 0 } },
    hardware_events: [], exceptions: [],
    inventory: { kiosks: [], slots_by_state: {}, power_banks: { total: 0, docked: 0, retired: 0 } },
    maintenance: [],
    certification: { physical_latest: null, runs_by_tier: {} },
    verification: emptyVerification(device, now, null, null),
  };
  if (kioskIds.length === 0) return empty;

  const [cmdRes, evRes, exRes, slotRes, bankRes, maintRes, certRes] = await Promise.all([
    db.from("device_commands").select(COMMAND_SELECT).in("kiosk_id", kioskIds)
      .order("created_at", { ascending: false }).limit(300),
    db.from("device_events").select("id,kiosk_id,event_type,payload,occurred_at")
      .in("kiosk_id", kioskIds).order("occurred_at", { ascending: false }).limit(20),
    db.from("rental_exceptions").select("id,kind,status,created_at,kiosk_id,detail")
      .in("kiosk_id", kioskIds).in("status", ["open", "investigating"]).order("created_at", { ascending: false }).limit(100),
    db.from("kiosk_slots").select("kiosk_id,state").in("kiosk_id", kioskIds).limit(2000),
    db.from("power_banks").select("id,current_kiosk,retired").in("current_kiosk", kioskIds).limit(2000),
    db.from("maintenance_visits").select("id,kiosk_id,technician,notes,visited_at")
      .in("kiosk_id", kioskIds).order("visited_at", { ascending: false }).limit(20),
    db.from("system_certification_runs")
      .select("id,tier,check_key,status,created_at")
      .eq("device_id", device.id).order("created_at", { ascending: false }).limit(100),
  ]);

  const cmds = (cmdRes.data ?? []) as unknown as CommandRow[];
  const open = cmds.filter((c) => OPEN_COMMAND_STATES.has(c.status));
  const counts = {
    open: open.length,
    failed: cmds.filter((c) => c.status === "failed").length,
    unknown_or_investigation: cmds.filter((c) => c.status === "unknown_outcome" || c.status === "requires_investigation").length,
    total: cmds.length,
  };
  const exceptionIds = new Set<string>();
  for (const r of (exRes.data ?? []) as { detail: Record<string, unknown> | null }[]) {
    const cid = payloadStr(r.detail, "command_id");
    if (cid) exceptionIds.add(cid);
  }
  const summaries = cmds.map((c) => toSummary(c, exceptionIds));

  const events = ((evRes.data ?? []) as { id: string | number; kiosk_id: string; event_type: string; payload: Record<string, unknown> | null; occurred_at: string | null }[])
    .slice(0, 20)
    .map((e) => ({
      id: String(e.id), kiosk_id: e.kiosk_id, event_type: e.event_type,
      occurred_at: e.occurred_at ?? null,
      outcome: payloadStr(e.payload, "outcome"),
      error_code: payloadStr(e.payload, "error_code"),
      simulated: e.payload?.simulated === true,
    }));

  // Inventory: slots for bound kiosks; banks docked at those kiosks.
  const slots = (slotRes.data ?? []) as { kiosk_id: string; state: string }[];
  const slotsByState: Record<string, number> = {};
  for (const s of slots) slotsByState[s.state] = (slotsByState[s.state] ?? 0) + 1;
  const banks = (bankRes.data ?? []) as { id: string; current_kiosk: string | null; retired: boolean | null }[];
  const inventory = {
    kiosks: kiosks.map((k) => ({ id: k.id, station_id: k.station_id, slot_count: k.slot_count })),
    slots_by_state: slotsByState,
    power_banks: {
      total: banks.length,
      docked: banks.filter((b) => !b.retired).length,
      retired: banks.filter((b) => b.retired === true).length,
    },
  };

  const certRuns = (certRes.data ?? []) as { id: string; tier: string; check_key: string; status: string; created_at: string }[];
  const runsByTier: Record<string, number> = {};
  for (const r of certRuns) runsByTier[r.tier] = (runsByTier[r.tier] ?? 0) + 1;
  const physicalLatest = certRuns.find((r) => r.tier === "physical") ?? null;

  // Latest positive/negative ack + simulated evidence across bound kiosks.
  let lastAckAt: string | null = null;
  let anySimulated = false;
  for (const e of events) {
    const evRow: AckEventRow = { id: e.id, event_type: e.event_type, occurred_at: e.occurred_at, payload: { outcome: e.outcome, error_code: e.error_code, simulated: e.simulated } };
    if (classifyAckEvent(evRow) !== "neutral" && e.occurred_at && (!lastAckAt || e.occurred_at > lastAckAt)) lastAckAt = e.occurred_at;
    if (e.simulated) anySimulated = true;
  }

  const exceptions = ((exRes.data ?? []) as { id: string; kind: string; status: string; created_at: string; kiosk_id: string | null }[])
    .map((x) => ({ id: x.id, kind: x.kind, status: x.status, created_at: x.created_at, kiosk_id: x.kiosk_id }));

  const maintenance = ((maintRes.data ?? []) as { id: string; kiosk_id: string; technician: string | null; notes: string | null; visited_at: string | null }[])
    .map((m) => ({ id: m.id, kiosk_id: m.kiosk_id, technician: m.technician, notes: m.notes, visited_at: m.visited_at }));

  const verification = emptyVerification(device, now, lastAckAt, physicalLatest, anySimulated);

  return {
    bound_kiosks: kiosks, unbound: false,
    commands: { open: summaries.filter((s) => OPEN_COMMAND_STATES.has(s.status)), recent: summaries.slice(0, 25), counts },
    hardware_events: events, exceptions, inventory, maintenance,
    certification: {
      physical_latest: physicalLatest ? { id: physicalLatest.id, check_key: physicalLatest.check_key, status: physicalLatest.status, created_at: physicalLatest.created_at } : null,
      runs_by_tier: runsByTier,
    },
    verification,
  };
}

function emptyVerification(
  device: SystemDeviceRow, now: Date,
  lastAckAt: string | null, physicalLatest: { status: string } | null,
  anySimulated = false,
): OpsDashboard["verification"] {
  // gateway_reachable: there is no live gateway ping path (KIOSK_ADAPTER=none
  // or unconfigured) — honest "unverifiable", never "reachable".
  const gateway = { state: "unverifiable" as const, detail: "No live gateway/link check exists — adapter path is not wired to hardware." };

  const hb = device.last_heartbeat_at ? new Date(device.last_heartbeat_at).getTime() : NaN;
  const heartbeat = !Number.isFinite(hb)
    ? { state: "no" as const, last_at: null, detail: "No heartbeat recorded — device has never reported." }
    : (now.getTime() - hb) <= HEARTBEAT_STALE_MIN * 60_000
      ? { state: "yes" as const, last_at: device.last_heartbeat_at, detail: `Heartbeat within the ${HEARTBEAT_STALE_MIN}-minute staleness window.` }
      : { state: "stale" as const, last_at: device.last_heartbeat_at, detail: `Heartbeat older than the ${HEARTBEAT_STALE_MIN}-minute staleness window.` };

  const ack = lastAckAt
    ? { state: "yes" as const, last_at: lastAckAt, detail: "Correlated command ack event recorded." }
    : { state: "no" as const, last_at: null, detail: "No correlated ack events recorded for bound kiosks." };

  const simulated = anySimulated
    ? { state: "yes" as const, detail: "At least one recorded event is flagged simulated — not hardware truth." }
    : { state: "no" as const, detail: "No simulated events on record for bound kiosks." };

  const physical = !physicalLatest
    ? { state: "no" as const, detail: "No physical-tier certification run recorded." }
    : physicalLatest.status === "pass"
      ? { state: "yes" as const, detail: "Latest physical-tier certification run passed." }
      : { state: "partial" as const, detail: `Latest physical-tier run status: ${physicalLatest.status}.` };

  return { gateway_reachable: gateway, heartbeat_received: heartbeat, ack_received: ack, simulated_evidence: simulated, physically_verified: physical };
}
