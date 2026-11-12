/**
 * Certification checklist catalog — shared by the console page (display) and
 * referenced by the API route's check_key validation notes. Pure data; no
 * server-only imports so the client component can use it directly.
 *
 * HONESTY: `simulated` and `gateway_contract` results verify SOFTWARE
 * CONTRACT behavior only. They are never physical hardware verification.
 * `physical` checks require a live device AND a fresh step-up elevation —
 * the API enforces the elevation; the device requirement is operational.
 */

export const CERTIFICATION_TIERS = ["simulated", "gateway_contract", "physical"] as const;
export type CertificationTier = (typeof CERTIFICATION_TIERS)[number];

export const CERTIFICATION_STATUSES = ["pass", "fail", "blocked", "skipped"] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export type CertificationCheck = {
  key: string;
  label: string;
  tier: CertificationTier;
  /** true = runnable by tests/hardware-certification.test.ts or the kiosk simulator today. */
  automated: boolean;
  /** true = additionally needs a real device / gateway hardware to execute. */
  needsHardware?: boolean;
  /** true = route additionally requires step-up elevation (always true for physical). */
  needsElevation?: boolean;
  /** Where the automated evidence lives (test suite / spec section). */
  evidence?: string;
  note?: string;
};

export const CERTIFICATION_CHECKS: readonly CertificationCheck[] = [
  /* ── SIMULATED — software-contract checks, no hardware involved ────────── */
  { key: "provisioning_contract", label: "Provisioning contract (credential issued once, enc+fingerprint stored)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C1" },
  { key: "hmac_auth", label: "HMAC-SHA256 device authentication", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C2" },
  { key: "heartbeat", label: "Heartbeat telemetry end-to-end", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C3" },
  { key: "inventory_reporting", label: "Inventory reporting (slot_state → kiosk_slots/power_banks)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C4" },
  { key: "diagnostics_readonly", label: "Read-only diagnostics honesty (adapter_unavailable, no fabricated ping)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C5" },
  { key: "rotation_overlap", label: "Credential rotation overlap (both secrets verify, promote-on-first-auth)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C6" },
  { key: "offline_detection", label: "Offline detection (stale heartbeat threshold)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C7" },
  { key: "reconnection", label: "Reconnection after offline window", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C8" },
  { key: "return_detection", label: "Return detection (bank docked back)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C9" },
  { key: "duplicate_replay_rejection", label: "Duplicate/replay rejection (message_id nonce, 409)", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C11" },
  { key: "invalid_signature", label: "Invalid signature rejection", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C12" },
  { key: "revoked_credential", label: "Revoked credential rejection", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C13" },
  { key: "expired_credential", label: "Expired credential rejection", tier: "simulated", automated: true, evidence: "hardware-certification.test.ts C14" },

  /* ── GATEWAY_CONTRACT — gateway protocol conformance ────────────────────── */
  { key: "message_schema_conformance", label: "Ingest message schema conformance (zod contract)", tier: "gateway_contract", automated: true, evidence: "src/lib/kiosk/ingest.ts + certification-runner" },
  { key: "idempotency_keys", label: "Idempotency keys (event_id dedup, message_id nonce 409, command idempotency)", tier: "gateway_contract", automated: true, evidence: "certification-runner.ts" },
  { key: "dispense_command_path", label: "Dispense/command path round-trip (queue → sim adapter → correlated ack → rental activated)", tier: "gateway_contract", automated: true, evidence: "certification-runner.ts via kiosk simulator", note: "Exercised through the simulator — simulated:true evidence, not hardware" },
  { key: "ack_correlation", label: "Command ack correlation (command_id ↔ ack; unknown command → rental_exceptions)", tier: "gateway_contract", automated: true, evidence: "certification-runner.ts via kiosk simulator", note: "Simulator session evidence — a live gateway remains the physical-tier proof" },

  /* ── PHYSICAL — real hardware only; route requires step-up elevation ────── */
  { key: "dispense_ack", label: "Physical dispense acknowledgement (motor/lock telemetry)", tier: "physical", automated: false, needsHardware: true, needsElevation: true, note: "Requires real device + fresh MFA step-up" },
  { key: "return_ack", label: "Physical return acknowledgement (dock sensor)", tier: "physical", automated: false, needsHardware: true, needsElevation: true, note: "Requires real device + fresh MFA step-up" },
  { key: "hardware_fault", label: "Hardware fault injection (jam/over-temp/comm loss)", tier: "physical", automated: false, needsHardware: true, needsElevation: true, note: "Requires real device + fresh MFA step-up" },
  { key: "payment_terminal_handshake", label: "Payment terminal handshake (EMV/socket)", tier: "physical", automated: false, needsHardware: true, needsElevation: true, note: "Requires real device + fresh MFA step-up" },
];

export const checksForTier = (tier: CertificationTier) => CERTIFICATION_CHECKS.filter((c) => c.tier === tier);

/** Latest-run lookup key: runs are chained per (device_id, tier). */
export const chainKey = (deviceId: string | null, tier: CertificationTier) => `${deviceId ?? "fleet"}|${tier}`;
