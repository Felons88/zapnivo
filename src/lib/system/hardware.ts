import type { SupabaseClient } from "@supabase/supabase-js";
import type { DiagnosticResult } from "./kiosks";

/**
 * Hardware readiness read model for the system console.
 *
 * Two honest data sources, never mixed:
 *  - `system_hardware_profiles` (migration 0044): vendor hardware capability +
 *    certification registry. Rows are added ONLY via ops migrations after a
 *    real unit and its protocol docs have been inspected — the table is
 *    intentionally empty until then, and there is NO write API.
 *  - `system_devices`: the fleet registry. Firmware inventory and per-device
 *    readiness are derived from stored columns only — nothing here claims a
 *    live hardware link (KIOSK_ADAPTER=none until a vendor adapter lands).
 */

export const HARDWARE_CERT_STATUSES = ["uncertified", "in_review", "certified", "deprecated"] as const;
export type HardwareCertStatus = (typeof HARDWARE_CERT_STATUSES)[number];

export type HardwareProfileRow = {
  id: string;
  manufacturer: string;
  model: string;
  protocol_doc_url: string | null;
  gateway_api_spec: string | null;
  auth_capabilities: Record<string, unknown>;
  dispense_supported: boolean;
  return_detection: boolean;
  inventory_reporting: boolean;
  heartbeat_supported: boolean;
  firmware_update: boolean;
  ad_screen: boolean;
  certification_status: HardwareCertStatus | string;
  test_results: Record<string, unknown>;
  created_at: string;
};

const PROFILE_SELECT =
  "id,manufacturer,model,protocol_doc_url,gateway_api_spec,auth_capabilities,dispense_supported,return_detection,inventory_reporting,heartbeat_supported,firmware_update,ad_screen,certification_status,test_results,created_at";

export async function listHardwareProfiles(db: SupabaseClient | null): Promise<{ configured: boolean; profiles: HardwareProfileRow[] }> {
  if (!db) return { configured: false, profiles: [] };
  const { data, error } = await db.from("system_hardware_profiles").select(PROFILE_SELECT)
    .order("manufacturer", { ascending: true }).order("model", { ascending: true }).limit(500);
  if (error) return { configured: true, profiles: [] };
  return { configured: true, profiles: (data ?? []) as HardwareProfileRow[] };
}

/* ── Capability checklist (fixed columns, rendered as a matrix) ───────────── */

export const CAPABILITY_CHECKS = [
  { key: "dispense_supported", label: "Dispense control" },
  { key: "return_detection", label: "Return detection" },
  { key: "inventory_reporting", label: "Inventory reporting" },
  { key: "heartbeat_supported", label: "Heartbeat" },
  { key: "firmware_update", label: "Firmware update" },
  { key: "ad_screen", label: "Ad screen" },
] as const;
export type CapabilityKey = (typeof CAPABILITY_CHECKS)[number]["key"];

/* ── Firmware inventory (real system_devices data, grouped) ───────────────── */

export type FirmwareGroup = {
  version: string; // "unknown" bucket for null/empty
  count: number;
  devices: { id: string; device_uid: string | null; manufacturer: string | null; model: string | null; status: string }[];
};

export async function firmwareInventory(db: SupabaseClient | null): Promise<{ configured: boolean; groups: FirmwareGroup[]; total: number }> {
  if (!db) return { configured: false, groups: [], total: 0 };
  const { data, error } = await db.from("system_devices")
    .select("id,device_uid,manufacturer,model,status,firmware_version")
    .order("created_at", { ascending: false }).limit(1000);
  if (error) return { configured: true, groups: [], total: 0 };
  const rows = (data ?? []) as { id: string; device_uid: string | null; manufacturer: string | null; model: string | null; status: string; firmware_version: string | null }[];
  const map = new Map<string, FirmwareGroup>();
  for (const r of rows) {
    const v = r.firmware_version?.trim() || "unknown";
    const g = map.get(v) ?? { version: v, count: 0, devices: [] };
    g.count += 1;
    g.devices.push({ id: r.id, device_uid: r.device_uid, manufacturer: r.manufacturer, model: r.model, status: r.status });
    map.set(v, g);
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count || a.version.localeCompare(b.version));
  return { configured: true, groups, total: rows.length };
}

/* ── Diagnostics readiness classification ─────────────────────────────────── */

/**
 * Ordered hardware-path stages. With KIOSK_ADAPTER=none the only stage that can
 * be 'verified' is api_reachable — everything downstream requires a real
 * adapter + certified profile and is honestly 'unverified' (never 'failed':
 * nothing was attempted against hardware).
 */
export const READINESS_STAGES = [
  "api_reachable",
  "gateway_reachable",
  "heartbeat_received",
  "device_responded",
  "hardware_confirmed",
] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];
export type ReadinessState = "verified" | "unverified" | "failed";
export type ReadinessCheck = { stage: ReadinessStage; state: ReadinessState; detail: string };

/**
 * Classifies a stored DiagnosticResult into per-stage readiness. `certified`
 * is true only when a system_hardware_profiles row matching the device's
 * manufacturer+model has certification_status='certified' — looked up by the
 * caller (runDeviceDiagnostics) and passed in.
 */
export function classifyReadiness(
  result: Pick<DiagnosticResult, "adapter" | "heartbeat_age_minutes">,
  opts: { certifiedProfile: boolean },
): ReadinessCheck[] {
  const adapterLive = result.adapter !== "none";
  return [
    {
      stage: "api_reachable",
      state: "verified",
      detail: "Control-plane API reachable — this diagnostics run executed server-side.",
    },
    {
      stage: "gateway_reachable",
      state: adapterLive ? "unverified" : "unverified",
      detail: adapterLive
        ? `Adapter "${result.adapter}" selected but no live gateway ping is implemented — unverified.`
        : "KIOSK_ADAPTER=none — no gateway link exists to verify.",
    },
    {
      stage: "heartbeat_received",
      state: result.heartbeat_age_minutes != null ? "verified" : "unverified",
      detail: result.heartbeat_age_minutes != null
        ? `Heartbeat recorded ${result.heartbeat_age_minutes} min ago (stored timestamp).`
        : "No heartbeat ever recorded for this device.",
    },
    {
      stage: "device_responded",
      state: "unverified",
      detail: "No command ack path exists (adapter=none records commands as failed/adapter_disabled) — device response cannot be verified.",
    },
    {
      stage: "hardware_confirmed",
      state: opts.certifiedProfile ? "verified" : "unverified",
      detail: opts.certifiedProfile
        ? "A certified hardware profile matches this manufacturer/model."
        : "No certified hardware profile on file — capability claims are unverified.",
    },
  ];
}
