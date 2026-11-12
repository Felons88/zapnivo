import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 2.5 — server-side device capability enforcement for kiosk event ingest.
 *
 * Capabilities are resolved ONLY from stored server-side records — NEVER from
 * event payloads or device self-report:
 *
 *  1. `system_devices.capabilities` (jsonb, staff-set at registration). Accepted
 *     shapes (all optional, combinable):
 *       - array of names:            ["dispense", "return-detect"]
 *       - map of name → truthy:      { "dispense": true, "return_detect": 1 }
 *       - nested containers:         { "capabilities": ["inventory_report"] }
 *       - mixed/nested objects:      { "features": { "dispense": true } }
 *     Falsy values (false, 0, "", null) never grant. String array items and
 *     truthy object keys/values are normalized (lowercase, `_` separators) and
 *     mapped through CAPABILITY_ALIASES onto the canonical vocabulary.
 *  2. `system_hardware_profiles` — there is NO FK link column; a profile is
 *     associated with a device by manufacturer+model equality AND
 *     certification_status='certified' (the same rule runDeviceDiagnostics in
 *     src/lib/system/kiosks.ts uses). Only the fixed boolean checklist columns
 *     grant capabilities; `auth_capabilities`/`test_results` jsonb are ignored
 *     (they describe auth schemes/test evidence, not ingest grants).
 *
 * Effective set = device-record capabilities ∪ certified-profile capabilities.
 * A device with no row / no capabilities data resolves to the EMPTY set:
 * gated event types are denied (fail-closed), baseline types still pass.
 */

/** Canonical capability names — the only strings requiredCapabilityFor() emits. */
export const CANONICAL_CAPABILITIES = [
  "heartbeat",
  "inventory_report",
  "return_detect",
  "dispense",
  "firmware_update",
  "ad_screen",
  "diagnostics",
] as const;
export type CanonicalCapability = (typeof CANONICAL_CAPABILITIES)[number];

/**
 * Baseline event types — ALWAYS allowed regardless of stored capabilities.
 * Rationale: heartbeat proves liveness (denying it would blind fleet
 * monitoring and last_seen_at projection) and hardware_fault is the device's
 * own distress signal — a faulty unit must always be able to report it.
 * Both are inert w.r.t. rentals/inventory beyond telemetry rows.
 */
export const BASELINE_EVENT_TYPES = new Set(["heartbeat", "hardware_fault"]);

/**
 * Event type → required capability. Covers every entry in KNOWN_EVENT_TYPES
 * (src/lib/kiosk/ingest.ts) that can affect state:
 *
 *   slot_state                     → inventory_report  (projects kiosk_slots/power_banks)
 *   power_bank_docked/bank_returned→ return_detect     (RETURN_EVENT_TYPES — completes rentals)
 *   return_detected/return_acknowledged/return_rejected → return_detect
 *   dispense_requested/dispense_acknowledged/dispense_failed/bank_released → dispense
 *     (ACK_EVENT_TYPES — can activate rentals via dispense acks)
 *
 * Unknown event types return null: they cannot trigger lifecycle transitions
 * (processKioskEvent logs them 'ignored'), so gating them would add no safety —
 * they still land in the immutable device_events log for audit. Documented
 * choice: unknown types are NOT capability-gated.
 */
const EVENT_CAPABILITY: Readonly<Record<string, CanonicalCapability>> = {
  slot_state: "inventory_report",
  power_bank_docked: "return_detect",
  bank_returned: "return_detect",
  return_detected: "return_detect",
  return_acknowledged: "return_detect",
  return_rejected: "return_detect",
  dispense_requested: "dispense",
  dispense_acknowledged: "dispense",
  dispense_failed: "dispense",
  bank_released: "dispense",
};

/**
 * The capability an event type requires, or null when none is needed
 * (baseline liveness/fault types and unknown pass-through types).
 */
export function requiredCapabilityFor(eventType: string): CanonicalCapability | null {
  if (BASELINE_EVENT_TYPES.has(eventType)) return null;
  return EVENT_CAPABILITY[eventType] ?? null;
}

/**
 * Normalizes a stored capability name onto the canonical vocabulary.
 * Accepts the real profile-column names (dispense_supported, return_detection,
 * inventory_reporting, heartbeat_supported) and common vendor spellings
 * (dock_detect, returns, ads…) as aliases.
 */
const CAPABILITY_ALIASES: Record<string, string> = {
  heartbeat: "heartbeat",
  heartbeat_supported: "heartbeat",
  inventory_report: "inventory_report",
  inventory_reporting: "inventory_report",
  inventory: "inventory_report",
  return_detect: "return_detect",
  return_detection: "return_detect",
  dock_detect: "return_detect",
  returns: "return_detect",
  dispense: "dispense",
  dispense_supported: "dispense",
  dispensing: "dispense",
  firmware_update: "firmware_update",
  firmware: "firmware_update",
  ad_screen: "ad_screen",
  ads: "ad_screen",
  advertising: "ad_screen",
  diagnostics: "diagnostics",
  diagnostic: "diagnostics",
};

export function normalizeCapabilityName(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
  return CAPABILITY_ALIASES[key] ?? key;
}

/**
 * Walks an arbitrary jsonb value collecting capability claims:
 *  - string array items            → capability names
 *  - object entries with truthy v  → the KEY is a claim; string values are
 *    also collected (the column is trusted staff input, not device self-report)
 *  - nested objects/arrays         → recursed (depth-capped)
 * Falsy scalars never grant — fail-closed on ambiguous shapes.
 */
function collectCapabilities(value: unknown, out: Set<string>, depth = 0): void {
  if (value == null || depth > 4) return;
  if (typeof value === "string") {
    const n = normalizeCapabilityName(value);
    if (n) out.add(n);
    return;
  }
  if (typeof value !== "object") return; // numbers/booleans carry no name
  if (Array.isArray(value)) {
    for (const v of value) collectCapabilities(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v == null || v === false || v === 0 || v === "") continue;
    const n = normalizeCapabilityName(k);
    if (n) out.add(n);
    collectCapabilities(v, out, depth + 1);
  }
}

/** Pure extraction from the raw system_devices.capabilities jsonb — no DB. */
export function capabilitiesFromDeviceRecord(capabilities: unknown): Set<string> {
  const out = new Set<string>();
  collectCapabilities(capabilities, out);
  return out;
}

/** The stored device fields capability resolution reads. */
export type DeviceCapabilitySource = {
  capabilities?: unknown;
  manufacturer?: string | null;
  model?: string | null;
} | null | undefined;

/** system_hardware_profiles boolean checklist → canonical capability. */
const PROFILE_CAPABILITY_COLUMNS = [
  ["dispense_supported", "dispense"],
  ["return_detection", "return_detect"],
  ["inventory_reporting", "inventory_report"],
  ["heartbeat_supported", "heartbeat"],
  ["firmware_update", "firmware_update"],
  ["ad_screen", "ad_screen"],
] as const;

/**
 * Resolves the effective capability set for a device from stored records only.
 * Never throws on missing data — absent source/columns yield an empty set
 * (fail-closed: baseline event types only).
 */
export async function resolveDeviceCapabilities(
  db: SupabaseClient,
  source: DeviceCapabilitySource,
): Promise<Set<string>> {
  const caps = capabilitiesFromDeviceRecord(source?.capabilities);

  const manufacturer = source?.manufacturer?.trim();
  const model = source?.model?.trim();
  if (manufacturer && model) {
    const { data } = await db.from("system_hardware_profiles")
      .select("dispense_supported,return_detection,inventory_reporting,heartbeat_supported,firmware_update,ad_screen")
      .eq("manufacturer", manufacturer)
      .eq("model", model)
      .eq("certification_status", "certified")
      .limit(1);
    const profile = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (profile) {
      for (const [col, cap] of PROFILE_CAPABILITY_COLUMNS) {
        if (profile[col] === true) caps.add(cap);
      }
    }
  }
  return caps;
}
