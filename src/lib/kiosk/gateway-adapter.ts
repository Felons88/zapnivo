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

/* ── Remote update delivery surface (Phase 4.3) ────────────────────────────── */

/**
 * Honest per-capability flags for the UPDATE-DELIVERY half of the gateway
 * contract. Separate from GatewayCapabilities because update delivery is an
 * OPTIONAL extension: a vendor adapter may satisfy the base GatewayAdapter
 * (commands/telemetry) without being able to move firmware/config artifacts.
 * The blocked adapter reports all-false.
 */
export type GatewayUpdateCapabilities = {
  /** Adapter can transfer a firmware/software artifact to the device
   *  (resumable transport, vendor-side integrity checks). */
  firmwareDelivery: boolean;
  /** Adapter can push whitelisted desired-state config (device-config.ts keys). */
  configUpdatePush: boolean;
  /** Adapter can poll the vendor-side state of an update job. */
  updateStatusQuery: boolean;
  /** Adapter can read back the device's actually-installed version. */
  installedVersionReport: boolean;
  /** Adapter can verify the device reconnected + is healthy post-update. */
  reconnectVerification: boolean;
  /** Adapter can restore a known-good artifact/config (rollback image). */
  rollbackSupport: boolean;
};

export const NO_UPDATE_CAPABILITIES: GatewayUpdateCapabilities = {
  firmwareDelivery: false, configUpdatePush: false, updateStatusQuery: false,
  installedVersionReport: false, reconnectVerification: false, rollbackSupport: false,
};

/** Correlation key every update call carries — commandId is the dedup key. */
export type GatewayUpdateJobRef = { deviceId: string; commandId: string };

/**
 * Firmware/software artifact delivery request. Reuses GatewayFirmwareArtifact
 * so sha256+signature stay REQUIRED — there is no unsigned delivery path.
 * `resumeToken` is an opaque vendor cursor from a prior interrupted transfer;
 * adapters that cannot resume MUST reject a non-empty resumeToken rather than
 * silently restart (restart semantics are the vendor's documented behavior).
 */
export type GatewayFirmwareDeliveryRequest = GatewayUpdateJobRef & {
  targetVersion: string;
  artifact: GatewayFirmwareArtifact;
  resumeToken?: string;
};

/** Desired-state config push. `desired` keys are the device-config.ts
 *  whitelist — the adapter forwards; validation stays server-side. */
export type GatewayConfigPushRequest = GatewayUpdateJobRef & {
  desired: Record<string, unknown>;
  /** Optional vendor config-schema version the payload conforms to. */
  schemaVersion?: string;
};

/** Acknowledgement that the vendor accepted the job for delivery. Acceptance
 *  is NOT completion — completion requires queryUpdateStatus evidence. */
export type GatewayUpdateJobAccepted = {
  commandId: string;
  /** Vendor-side job/transfer id when the transport exposes one. */
  transferId?: string;
  acceptedAt: string;
};

/**
 * Vendor-reported update job state. Mirrors the kiosk_update_targets state
 * machine (migration 0067): queued→transferring→installing→reconnecting→
 * verifying→completed, plus failure/unknown_outcome/cancelled branches.
 * 'completed' is only meaningful WITH evidence (installed version + health).
 */
export type GatewayUpdateJobState =
  | "queued" | "transferring" | "installing" | "reconnecting"
  | "verifying" | "completed" | "failed" | "unknown_outcome" | "cancelled";

export type GatewayUpdateStatusReport = {
  deviceId: string;
  commandId: string;
  state: GatewayUpdateJobState;
  detail?: string;
  /** Telemetry proof captured by the adapter/vendor — required before any
   *  caller may mark a target 'completed'. */
  evidence?: {
    installedVersion?: string;
    healthOk?: boolean | null;
    reportedAt?: string;
  };
};

/** Authoritative installed-version readback (telemetry or direct query). */
export type GatewayInstalledVersion = {
  deviceId: string;
  commandId?: string;
  installedVersion: string;
  reportedAt: string;
  source: "telemetry" | "query";
};

/** Post-update reconnect + health proof. `verified` must mean the device
 *  re-established its authenticated channel AND passed health checks — never
 *  a bare TCP/ping success. */
export type GatewayReconnectCheck = {
  deviceId: string;
  commandId: string;
  verified: boolean;
  detail?: string;
  checkedAt: string;
};

/**
 * Rollback request. `rollbackRef` is an opaque vendor reference to the
 * known-good artifact/config to restore; sha256+signature are REQUIRED —
 * rollback goes through the same signed-artifact rules as forward updates.
 */
export type GatewayRollbackRequest = GatewayUpdateJobRef & {
  rollbackRef: string;
  targetVersion?: string;
  sha256: string;
  signature: string;
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

/* ── Optional update-delivery extension ────────────────────────────────────── */

/**
 * OPTIONAL extension interface for remote update delivery (Phase 4.3).
 * A vendor adapter is NOT required to implement this — command/telemetry
 * adapters may legitimately lack artifact transport. Callers MUST check
 * `isGatewayUpdateCapable()` / `updateCapabilitiesOf()` before invoking any
 * method here; a non-implementing adapter is reported as all-false and every
 * call resolves to `unsupported_capability` — never a fabricated job id.
 *
 * Conformance requirements (docs/GATEWAY-ADAPTER.md §6):
 *
 *  1. updateCapabilities — honest flags; false = cannot do.
 *  2. deliverFirmwareArtifact / pushConfigUpdate — idempotent on commandId;
 *     return an ACCEPTED receipt, never claim installation.
 *  3. queryUpdateStatus — map vendor job state onto GatewayUpdateJobState;
 *     'completed' MUST carry evidence (installedVersion + healthOk) from
 *     authenticated device telemetry, not vendor optimism.
 *  4. reportInstalledVersion — read back what the device reports; a version
 *     the device never reported is a failure, not a guess.
 *  5. verifyReconnect — post-update proof over the authenticated channel.
 *  6. requestRollback — signed artifacts only; same rules as forward updates.
 */
export interface GatewayUpdateCapable {
  /** Honest update-delivery capability flags. */
  updateCapabilities(): GatewayUpdateCapabilities;

  deliverFirmwareArtifact(req: GatewayFirmwareDeliveryRequest): Promise<GatewayResult<GatewayUpdateJobAccepted>>;
  pushConfigUpdate(req: GatewayConfigPushRequest): Promise<GatewayResult<GatewayUpdateJobAccepted>>;
  queryUpdateStatus(ref: GatewayUpdateJobRef): Promise<GatewayResult<GatewayUpdateStatusReport>>;
  reportInstalledVersion(ref: { deviceId: string; commandId?: string }): Promise<GatewayResult<GatewayInstalledVersion>>;
  verifyReconnect(ref: GatewayUpdateJobRef): Promise<GatewayResult<GatewayReconnectCheck>>;
  requestRollback(req: GatewayRollbackRequest): Promise<GatewayResult<GatewayUpdateJobAccepted>>;
}

const UPDATE_CAPABILITY_KEYS = [
  "firmwareDelivery", "configUpdatePush", "updateStatusQuery",
  "installedVersionReport", "reconnectVerification", "rollbackSupport",
] as const satisfies readonly (keyof GatewayUpdateCapabilities)[];

/** True when the adapter implements the FULL update-delivery surface. */
export function isGatewayUpdateCapable(
  adapter: GatewayAdapter,
): adapter is GatewayAdapter & GatewayUpdateCapable {
  const u = adapter as Partial<GatewayUpdateCapable>;
  return (
    typeof u.updateCapabilities === "function" &&
    typeof u.deliverFirmwareArtifact === "function" &&
    typeof u.pushConfigUpdate === "function" &&
    typeof u.queryUpdateStatus === "function" &&
    typeof u.reportInstalledVersion === "function" &&
    typeof u.verifyReconnect === "function" &&
    typeof u.requestRollback === "function"
  );
}

/**
 * Capability view for ANY adapter: real flags when update-capable, all-false
 * otherwise. This is what callers should consult — never assume capability
 * from the adapter's name.
 */
export function updateCapabilitiesOf(adapter: GatewayAdapter): GatewayUpdateCapabilities {
  if (!isGatewayUpdateCapable(adapter)) return { ...NO_UPDATE_CAPABILITIES };
  const caps = adapter.updateCapabilities();
  // Defensive: a buggy adapter must not report truthy non-booleans.
  const out = { ...NO_UPDATE_CAPABILITIES };
  for (const k of UPDATE_CAPABILITY_KEYS) out[k] = caps[k] === true;
  return out;
}

/** Standard honest error for an update capability the adapter lacks. */
export function unsupportedUpdate(capability: keyof GatewayUpdateCapabilities, detail?: string): GatewayError {
  return {
    code: "unsupported_capability",
    detail: detail ?? `gateway adapter does not support the "${capability}" update-delivery capability`,
  };
}

/* ── Blocked implementation (the only real one today) ──────────────────────── */

/**
 * Fail-closed adapter: every capability false, every call returns the SAME
 * explicit error it was constructed with. This is what KIOSK_ADAPTER=none (and
 * any unregistered selection) resolves to — dispatch paths record honest
 * failures instead of pretending hardware was contacted.
 */
export function blockedAdapter(error: GatewayError): GatewayAdapter & GatewayUpdateCapable {
  const fail = <T>(): GatewayResult<T> => blocked<T>(error);
  // Update-delivery calls on the blocked adapter report unsupported_capability
  // (the capability genuinely does not exist here) while base calls keep the
  // configured adapter_not_configured/documentation_required error.
  const failUpdate = <T>(capability: keyof GatewayUpdateCapabilities): GatewayResult<T> =>
    blocked<T>(unsupportedUpdate(capability, `${error.detail} Update-delivery capability "${capability}" is not supported.`));
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
    updateCapabilities: () => ({ ...NO_UPDATE_CAPABILITIES }),
    deliverFirmwareArtifact: async () => failUpdate("firmwareDelivery"),
    pushConfigUpdate: async () => failUpdate("configUpdatePush"),
    queryUpdateStatus: async () => failUpdate("updateStatusQuery"),
    reportInstalledVersion: async () => failUpdate("installedVersionReport"),
    verifyReconnect: async () => failUpdate("reconnectVerification"),
    requestRollback: async () => failUpdate("rollbackSupport"),
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
