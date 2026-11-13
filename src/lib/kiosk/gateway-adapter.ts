import type {
  CommandAck, CommandEnvelope, DeviceCredentials, KioskHeartbeat,
  KioskContractError, OfflineReconciliationReport, ReturnResult,
} from "./adapter-contract";
import type { DispenseRequest, DispenseResult, KioskHealth } from "./adapter";

/**
 * Gateway adapter interface — the server→gateway seam for physical kiosk
 * hardware. TYPES + a fail-closed blocked implementation ONLY.
 *
 * This is the OUTBOUND half of the hardware contract: adapter-contract.ts
 * documents the types a vendor adapter must satisfy, ingest.ts /
 * device-auth.ts implement the INBOUND half (device→server HMAC ingest is
 * already live). This module defines what a future vendor adapter
 * implementation must provide and how the server resolves it via
 * KIOSK_ADAPTER.
 *
 * STATUS: KIOSK_ADAPTER=none is the only real configuration today.
 * getGatewayAdapter() ALWAYS returns a blocked adapter — there is no
 * registered vendor implementation, and docs/GATEWAY-ADAPTER.md lists the
 * vendor documentation + certification required before one may land.
 * Every method on the blocked adapter returns an explicit
 * 'adapter_not_configured' / 'documentation_required' error — never a
 * fabricated success.
 */

/* ── Capability flags ──────────────────────────────────────────────────────── */

/**
 * Honest per-capability flags. A real adapter MUST report false for anything
 * it cannot do — the UI/readiness surfaces render these verbatim. The blocked
 * adapter reports all-false.
 */
export type GatewayCapabilities = {
  /** Adapter can authenticate to the vendor gateway/cloud with stored credentials. */
  auth: boolean;
  /** Adapter accepts normalized heartbeat batches (KioskHeartbeat). */
  heartbeatIngest: boolean;
  /** Adapter accepts slot/inventory snapshots. */
  inventoryIngest: boolean;
  /** Adapter can deliver server→device commands (CommandEnvelope). */
  commandDispatch: boolean;
  /** Adapter can report command ack state (CommandAck lookup). */
  commandStatus: boolean;
  /** Adapter can execute a dispense (idempotent on commandId). */
  dispense: boolean;
  /** Adapter can report physical dock/return events (ReturnResult). */
  return: boolean;
  /** Adapter can push desired-state config updates to the device. */
  configUpdate: boolean;
  /** Adapter can push SIGNED firmware artifacts — never unsigned binaries. */
  firmwareUpdate: boolean;
  /** Adapter can run an on-demand diagnostic snapshot. */
  diagnostics: boolean;
};

export const NO_GATEWAY_CAPABILITIES: GatewayCapabilities = {
  auth: false, heartbeatIngest: false, inventoryIngest: false,
  commandDispatch: false, commandStatus: false, dispense: false,
  return: false, configUpdate: false, firmwareUpdate: false,
  diagnostics: false,
};

/* ── Typed requests / results ──────────────────────────────────────────────── */

/** Slot-level inventory snapshot a gateway reports (subset of heartbeat telemetry, batch form). */
export type GatewayInventoryReport = {
  kioskId: string;
  at: string;
  slots: {
    slot: number;
    state: "empty" | "charging" | "ready" | "fault";
    powerBankId?: string;
    batteryPct?: number;
  }[];
};

/** Return-side request envelope (dock event pushed through the adapter path). */
export type GatewayReturnRequest = {
  commandId: string;
  kioskId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  slot?: number;
  powerBankId?: string;
  payload?: Record<string, unknown>;
};

/** Desired-state config pushed to a device (whitelist lives in system/device-config.ts). */
export type GatewayConfigUpdate = {
  deviceId: string;
  commandId: string;
  desired: Record<string, unknown>;
};

/**
 * Firmware artifact reference. `signature`/`sha256` are REQUIRED fields a real
 * adapter must verify before flashing — the interface refuses to model an
 * unsigned update path. There is no artifact source today.
 */
export type GatewayFirmwareArtifact = {
  deviceId: string;
  commandId: string;
  version: string;
  /** Vendor artifact URL or opaque package id — never a local path. */
  artifactRef: string;
  sha256: string;
  signature: string;
};

export type GatewayDiagnostics = {
  checkedAt: string;
  adapter: string;
  checks: { name: string; ok: boolean | null; detail: string }[];
};

/* ── Result / error taxonomy ───────────────────────────────────────────────── */

/**
 * Adapter-level failure codes. Distinct from KioskErrorCode (device-side
 * normalization): these describe why the ADAPTER ITSELF could not serve the
 * call — configuration and capability gaps, not device faults.
 */
export type GatewayErrorCode =
  | "adapter_not_configured"   // KIOSK_ADAPTER unset/none — no adapter selected
  | "documentation_required"   // a name is selected but no certified implementation exists
  | "unsupported_capability"   // adapter exists but lacks the capability flag
  | "adapter_error";           // vendor transport/protocol failure (retryable per detail)

export type GatewayError = {
  code: GatewayErrorCode;
  detail: string;
  /** Maps vendor failures into KioskContractError shape when crossing the boundary. */
  contract?: KioskContractError;
};

export type GatewayResult<T> = { ok: true; data: T } | { ok: false; error: GatewayError };

const blocked = <T>(error: GatewayError): GatewayResult<T> => ({ ok: false, error });

/* ── The interface a vendor adapter must implement ─────────────────────────── */

/**
 * Full gateway adapter contract. Every method returns GatewayResult — a real
 * adapter MUST fail with an honest error rather than fabricate success.
 * Conformance requirements (enforced by docs/GATEWAY-ADAPTER.md checklist):
 *
 *  1. auth — resolve per-device vendor credentials; reject unknown devices.
 *  2. ingestHeartbeat / ingestInventory — accept normalized telemetry; the
 *     server-side ingest pipeline (ingest.ts) remains the system of record.
 *  3. dispatchCommand — deliver CommandEnvelope idempotently (commandId is the
 *     dedup key); report CommandAck, never silent success.
 *  4. commandStatus — report the device's ack state for a dispatched command.
 *  5. dispense / reportReturn — physical actions; idempotent, expiry-enforcing.
 *  6. updateConfig — push whitelisted desired-state (device-config.ts keys).
 *  7. updateFirmware — SIGNED artifacts only; sha256+signature verified
 *     adapter-side before any flash. No unsigned path may exist.
 *  8. diagnostics — bounded read-only snapshot; never a live ping fabricated
 *     as a result.
 */
export interface GatewayAdapter {
  /** Stable adapter identifier reported in readiness/diagnostics (e.g. "none", "acme-gw-1"). */
  readonly name: string;
  /** Honest capability flags — false means "cannot do", not "not implemented yet". */
  capabilities(): GatewayCapabilities;

  authenticate(device: { kioskId: string; unitLabel?: string; firmwareVersion?: string }):
    Promise<GatewayResult<DeviceCredentials>>;

  ingestHeartbeat(hb: KioskHeartbeat): Promise<GatewayResult<{ accepted: number }>>;
  ingestInventory(report: GatewayInventoryReport): Promise<GatewayResult<{ accepted: number }>>;

  dispatchCommand(envelope: CommandEnvelope): Promise<GatewayResult<CommandAck>>;
  commandStatus(commandId: string): Promise<GatewayResult<CommandAck | null>>;

  dispense(request: DispenseRequest): Promise<GatewayResult<DispenseResult>>;
  reportReturn(request: GatewayReturnRequest): Promise<GatewayResult<ReturnResult>>;

  updateConfig(update: GatewayConfigUpdate): Promise<GatewayResult<{ commandId: string }>>;
  updateFirmware(artifact: GatewayFirmwareArtifact): Promise<GatewayResult<{ commandId: string }>>;

  diagnostics(device: { kioskId: string }): Promise<GatewayResult<GatewayDiagnostics>>;

  /** Offline replay contract — see adapter-contract.ts OfflineReconciliationReport. */
  reconcile(report: OfflineReconciliationReport): Promise<GatewayResult<{ applied: number; duplicates: number }>>;
}

/* ── Blocked implementation (the only real one today) ──────────────────────── */

/**
 * Fail-closed adapter: every capability false, every call returns the SAME
 * explicit error it was constructed with. This is what KIOSK_ADAPTER=none (and
 * any unregistered selection) resolves to — dispatch paths record honest
 * failures instead of pretending hardware was contacted.
 */
export function blockedAdapter(error: GatewayError): GatewayAdapter {
  const fail = <T>(): GatewayResult<T> => blocked<T>(error);
  return {
    name: "blocked",
    capabilities: () => ({ ...NO_GATEWAY_CAPABILITIES }),
    authenticate: async () => fail(),
    ingestHeartbeat: async () => fail(),
    ingestInventory: async () => fail(),
    dispatchCommand: async () => fail(),
    commandStatus: async () => fail(),
    dispense: async () => fail(),
    reportReturn: async () => fail(),
    updateConfig: async () => fail(),
    updateFirmware: async () => fail(),
    diagnostics: async () => fail(),
    reconcile: async () => fail(),
  };
}

export const ADAPTER_NOT_CONFIGURED: GatewayError = {
  code: "adapter_not_configured",
  detail: "KIOSK_ADAPTER is unset or 'none' — no gateway adapter is selected. See docs/GATEWAY-ADAPTER.md for the vendor documentation + certification required before one may be registered.",
};

export function documentationRequired(selected: string): GatewayError {
  return {
    code: "documentation_required",
    detail: `KIOSK_ADAPTER="${selected}" is selected but no certified adapter implementation is registered for it. A vendor adapter may only land after the checklist in docs/GATEWAY-ADAPTER.md is satisfied.`,
  };
}

/* ── Resolution seam ───────────────────────────────────────────────────────── */

/**
 * Registry of certified vendor adapters. INTENTIONALLY EMPTY: an entry may be
 * added only after the vendor's protocol documentation has been inspected and
 * the adapter passes the certification checklist (docs/GATEWAY-ADAPTER.md).
 * Key = the KIOSK_ADAPTER env value.
 */
const REGISTERED_GATEWAY_ADAPTERS: Record<string, () => GatewayAdapter> = {};

/**
 * Resolves the configured gateway adapter. FAILS CLOSED:
 *  - unset / "none"        → adapter_not_configured
 *  - "simulator"           → adapter_not_configured (the simulator is a
 *                            KioskAdapter test double, not a hardware gateway)
 *  - anything else         → documentation_required unless a certified
 *                            implementation is registered above.
 */
export function getGatewayAdapter(): GatewayAdapter {
  const env = process.env.KIOSK_ADAPTER?.trim().toLowerCase() ?? "";
  if (!env || env === "none" || env === "simulator") {
    return blockedAdapter(ADAPTER_NOT_CONFIGURED);
  }
  const factory = REGISTERED_GATEWAY_ADAPTERS[env];
  if (factory) return factory();
  return blockedAdapter(documentationRequired(env));
}

/** Test/registration hook — production code should not call this. */
export function __registerGatewayAdapterForTests(name: string, factory: () => GatewayAdapter): void {
  REGISTERED_GATEWAY_ADAPTERS[name] = factory;
}
export function __unregisterGatewayAdapterForTests(name: string): void {
  delete REGISTERED_GATEWAY_ADAPTERS[name];
}
