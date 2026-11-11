/**
 * Kiosk hardware adapter contract — TYPES ONLY, no implementation.
 *
 * This file documents the boundary between Zapnivo's server and a physical kiosk
 * (vendor TBD — MQTT / HTTP / BLE / vendor cloud is unknown until the unit and its
 * docs are inspected). It deliberately does NOT implement anything:
 *
 *   - `src/lib/kiosk/adapter.ts`        — the server-side facade (`KioskAdapter`,
 *                                         `NullKioskAdapter`, `IdempotentKioskAdapter`,
 *                                         `getKioskAdapter`). This is what routes call.
 *   - `src/lib/kiosk/ingest.ts`         — authenticated event ingest pipeline.
 *   - `src/lib/kiosk/commands.ts`       — durable `device_commands` queue.
 *   - `src/lib/kiosk/lifecycle.ts`      — rental state machine driven by device events.
 *
 * STATUS: `KIOSK_ADAPTER` remains "none" (NullKioskAdapter) until a real adapter is
 * verified against hardware. Nothing here claims hardware compatibility.
 */

import type { DispenseRequest, DispenseResult, KioskHealth } from "./adapter";

/* ── Device identity & credentials ─────────────────────────────────────────── */

/**
 * How a kiosk authenticates to Zapnivo ingest/command endpoints.
 *
 * - `device_key`: per-device credential provisioned at install time (preferred —
 *   revocable per unit, scoped to one kiosk_id).
 * - `shared_secret`: fallback to the single `KIOSK_INGEST_SECRET` env value used by
 *   the current HTTP routes. Acceptable for pilots; must be replaced by device keys
 *   before fleet scale-out.
 */
export type DeviceAuthMethod = "device_key" | "shared_secret";

export type DeviceCredentials = {
  /** Kiosk row id in `kiosks` (uuid). */
  kioskId: string;
  /** Human-facing unit label, e.g. "ZN-ATL-014". */
  unitLabel: string;
  authMethod: DeviceAuthMethod;
  /**
   * For `device_key`: the per-device secret (hashed at rest server-side; the device
   * holds the raw value). For `shared_secret`: null — auth falls back to
   * `KIOSK_INGEST_SECRET`.
   */
  secret: string | null;
  /** Firmware/hardware revision reported at provisioning, for compatibility gating. */
  firmwareVersion?: string;
};

/* ── Command envelope (server → device) ────────────────────────────────────── */

/**
 * Envelope for every command pushed to a kiosk. `commandId` is the idempotency key:
 * a device MUST treat a repeated `commandId` as a no-op (see `device_commands`
 * unique idempotency_key and `IdempotentKioskAdapter`).
 */
export type CommandEnvelope = {
  /** UUID, unique per logical command — the idempotency key. */
  commandId: string;
  /** Maps to KioskCommand in commands.ts: disable | enable | reboot | unlock_slot | dispense. */
  command: string;
  kioskId: string;
  /** Server UTC issuance time (ISO-8601). */
  issuedAt: string;
  /** Commands past this instant MUST be rejected by the device. */
  expiresAt: string;
  /** Random per-command value for replay detection alongside commandId. */
  nonce: string;
  /** Command-specific payload (slot number, dispense request, etc.). */
  payload?: Record<string, unknown>;
};

/**
 * Acknowledgement the device returns for a CommandEnvelope. `accepted` means the
 * device took responsibility; `completed`/`failed` are terminal outcomes. A command
 * that never acks within the adapter's timeout is reported as `timeout`, never as
 * success.
 */
export type CommandAck =
  | { commandId: string; state: "accepted" | "completed"; at: string }
  | { commandId: string; state: "failed" | "timeout" | "expired"; reason: string; at: string };

/* ── Dispense / return results ──────────────────────────────────────────────── */

export type { DispenseRequest, DispenseResult, KioskHealth };

/**
 * Result of a physical bank return reported BY the device (dock event). This is the
 * hardware-side shape; the server-side interpretation lives in lifecycle.ts
 * (`processKioskEvent`) which verifies bank↔rental identity before completing.
 */
export type ReturnResult =
  | { status: "reported"; slot: number; powerBankId: string; at: string }
  | { status: "rejected"; reason: "unknown_slot" | "empty_slot" | "sensor_fault" | "unrecognized_bank" };

/* ── Telemetry & heartbeat ingest ───────────────────────────────────────────── */

/** One slot's state inside a heartbeat/telemetry batch. */
export type SlotTelemetry = {
  slot: number;
  state: "empty" | "charging" | "ready" | "fault";
  powerBankId?: string;
  batteryPct?: number;
};

/**
 * Periodic heartbeat a kiosk pushes (matches ingest.ts `ingestBodySchema`).
 * Staleness is judged server-side by heartbeat.ts (HEARTBEAT_STALE_MIN = 15).
 */
export type KioskHeartbeat = {
  kioskId: string;
  at: string;
  firmwareVersion?: string;
  slots: SlotTelemetry[];
  /** Free-form diagnostics (temps, errors); server stores, never trusts for control. */
  diagnostics?: Record<string, unknown>;
};

/* ── Offline reconciliation ─────────────────────────────────────────────────── */

/**
 * What a kiosk buffered while partitioned from the server. On reconnect the device
 * replays these; the server dedupes on eventId (kiosk_events.event_id unique) and
 * command acks reconcile device_commands rows stuck in `sent`.
 */
export type OfflineReconciliationReport = {
  kioskId: string;
  /** ISO window the device was offline, if it knows. */
  offlineFrom?: string;
  offlineTo?: string;
  /** Buffered device events to replay, oldest first. */
  pendingEvents: {
    eventId: string;
    type: string;
    at: string;
    slot?: number;
    powerBankId?: string;
    payload?: Record<string, unknown>;
  }[];
  /** Command ids the device executed while offline (for ack reconciliation). */
  executedCommandIds: string[];
  /** Command ids the device rejected/expired while offline. */
  failedCommandIds: { commandId: string; reason: string }[];
};

/* ── Error taxonomy ─────────────────────────────────────────────────────────── */

/**
 * Normalized error codes a hardware adapter must map vendor errors into, so the
 * server can decide retry/alert policy without vendor-specific strings.
 */
export type KioskErrorCode =
  | "unauthorized"        // bad/missing credentials
  | "device_unknown"      // kiosk_id not provisioned
  | "offline"             // device unreachable / link down
  | "timeout"             // command ack not received in time
  | "no_inventory"        // no ready bank in any slot
  | "hardware_fault"      // motor/sensor/lock failure
  | "unsupported"         // adapter lacks the capability (e.g. NullKioskAdapter)
  | "duplicate"           // idempotency key already seen — safe no-op
  | "expired"             // command past expiresAt
  | "rejected"            // device refused (policy, maintenance mode, …)
  | "unknown";            // unmapped vendor error — alert, don't retry blindly

export type KioskContractError = {
  code: KioskErrorCode;
  /** Vendor detail for logs only — never shown to customers. */
  detail?: string;
  retryable: boolean;
};

/* ── The contract a real adapter must satisfy ───────────────────────────────── */

/**
 * Hardware-facing surface a vendor adapter implements; the existing `KioskAdapter`
 * (adapter.ts) is the narrower server facade built on top of it. A conforming
 * adapter MUST:
 *
 *  1. identify(device) → resolve DeviceCredentials → auth result (reject unknown).
 *  2. dispense(command) → idempotent ack: same CommandEnvelope.commandId MUST NOT
 *     release a second bank; enforce expiresAt; report timeout, never silent success.
 *  3. reportReturn(slotEvent) → emit a ReturnResult; physical truth only.
 *  4. Accept KioskHeartbeat batches and produce OfflineReconciliationReport on
 *     reconnect so buffered events/commands reconcile without double effects.
 *  5. Map every failure into KioskErrorCode — no raw vendor strings cross the boundary.
 */
export interface HardwareKioskAdapter {
  readonly contractVersion: 1;
  identify(device: { unitLabel?: string; firmwareVersion?: string }): Promise<
    | { ok: true; credentials: DeviceCredentials }
    | { ok: false; error: KioskContractError }
  >;
  dispense(envelope: CommandEnvelope): Promise<CommandAck>;
  reportReturn(envelope: CommandEnvelope): Promise<ReturnResult>;
  ingestHeartbeat(hb: KioskHeartbeat): Promise<{ accepted: number }>;
  reconcile(report: OfflineReconciliationReport): Promise<{ applied: number; duplicates: number }>;
}
