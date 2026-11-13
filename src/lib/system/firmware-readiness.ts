import type { SupabaseClient } from "@supabase/supabase-js";
import {
  firmwareInventory, listHardwareProfiles,
  type FirmwareGroup, type HardwareProfileRow,
} from "./hardware";
import { kioskAdapterName } from "./kiosks";

/**
 * Firmware rollout READINESS read model for /system/kiosks/firmware.
 *
 * Read-only. There is NO firmware execution path — no artifact pipeline, no
 * signing docs, no adapter (KIOSK_ADAPTER=none). This module shapes stored
 * data (system_devices firmware_version + system_hardware_profiles capability
 * claims) into an honest per-model compatibility + readiness view, and lists
 * the concrete blockers that must clear before any rollout could exist.
 *
 * Data sources (never fabricated):
 *  - system_hardware_profiles (migration 0044): ops-managed capability +
 *    certification claims; protocol_doc_url / gateway_api_spec /
 *    firmware_update / certification_status.
 *  - system_devices: reported firmware_version grouped per model.
 */

export type FirmwareDevice = FirmwareGroup["devices"][number] & { firmware_version: string | null };

export type ReadinessItem = { item: string; ok: boolean; detail: string };

export type ModelFirmwareCompatibility = {
  manufacturer: string;
  model: string;
  /** Matching system_hardware_profiles row, or null when the model is unprofiled. */
  profile: HardwareProfileRow | null;
  certification: string; // profile.certification_status or "no_profile"
  deviceCount: number;
  /** Distinct reported firmware versions on this model ("unknown" = unreported). */
  firmwareVersions: string[];
  devices: FirmwareDevice[];
  /** Per-model readiness checklist derived ONLY from stored fields. */
  checklist: ReadinessItem[];
};

export type FirmwareReadiness = {
  configured: boolean;
  /** KIOSK_ADAPTER as configured ("none" today). */
  adapter: string;
  models: ModelFirmwareCompatibility[];
  /** Firmware-version groups (existing inventory view) passed through. */
  versionGroups: FirmwareGroup[];
  totalDevices: number;
  /** Concrete, honest reasons a rollout cannot proceed today. */
  rolloutBlockers: string[];
};

function modelChecklist(profile: HardwareProfileRow | null, versions: string[]): ReadinessItem[] {
  return [
    {
      item: "Vendor protocol documentation on file",
      ok: !!profile?.protocol_doc_url,
      detail: profile?.protocol_doc_url
        ? `protocol_doc_url recorded`
        : "No protocol_doc_url on the hardware profile — vendor docs not on file.",
    },
    {
      item: "Gateway API spec on file",
      ok: !!profile?.gateway_api_spec,
      detail: profile?.gateway_api_spec
        ? `gateway_api_spec recorded`
        : "No gateway_api_spec on the hardware profile.",
    },
    {
      item: "Hardware profile certified",
      ok: profile?.certification_status === "certified",
      detail: profile
        ? `certification_status='${profile.certification_status}'`
        : "No system_hardware_profiles row matches this manufacturer+model.",
    },
    {
      item: "Firmware update capability claimed",
      ok: profile?.firmware_update === true,
      detail: profile
        ? `firmware_update=${profile.firmware_update}`
        : "Unprofiled model — capability unknown.",
    },
    {
      item: "Devices reporting firmware versions",
      ok: versions.some((v) => v !== "unknown"),
      detail: versions.some((v) => v !== "unknown")
        ? `${versions.filter((v) => v !== "unknown").length} reported version(s)`
        : "No device on this model has reported a firmware_version.",
    },
  ];
}

/**
 * Builds the firmware readiness view. `db` may be null (unconfigured backend)
 * → { configured:false } with empty collections, matching firmwareInventory's
 * contract.
 */
export async function firmwareReadiness(db: SupabaseClient | null): Promise<FirmwareReadiness> {
  const adapter = kioskAdapterName();
  if (!db) {
    return {
      configured: false, adapter,
      models: [], versionGroups: [], totalDevices: 0,
      rolloutBlockers: ["Backend not configured — no device or profile data available."],
    };
  }

  const [profilesRes, inv] = await Promise.all([
    listHardwareProfiles(db),
    firmwareInventory(db),
  ]);
  const profiles = profilesRes.profiles;

  // Flatten inventory groups back to per-device rows carrying firmware_version.
  // firmwareInventory groups BY version, so re-derive the model view from the
  // same device list: each group's devices lack firmware_version, so fetch the
  // flat device set directly for accurate per-model versions.
  const { data: devRows } = await db.from("system_devices")
    .select("id,device_uid,manufacturer,model,status,firmware_version")
    .order("created_at", { ascending: false }).limit(1000);
  const devices = (devRows ?? []) as FirmwareDevice[];

  // Group devices by manufacturer+model.
  const byModel = new Map<string, FirmwareDevice[]>();
  for (const d of devices) {
    const key = `${d.manufacturer ?? ""}|${d.model ?? ""}`;
    const arr = byModel.get(key) ?? [];
    arr.push(d);
    byModel.set(key, arr);
  }

  const profileFor = (manufacturer: string | null, model: string | null) =>
    profiles.find((p) => p.manufacturer === manufacturer && p.model === model) ?? null;

  const models: ModelFirmwareCompatibility[] = [...byModel.entries()]
    .map(([key, devs]) => {
      const [manufacturer, model] = key.split("|");
      const mfr = manufacturer || null;
      const mdl = model || null;
      const profile = profileFor(mfr, mdl);
      const versions = [...new Set(devs.map((d) => d.firmware_version?.trim() || "unknown"))].sort();
      return {
        manufacturer: mfr ?? "—",
        model: mdl ?? "—",
        profile,
        certification: profile?.certification_status ?? "no_profile",
        deviceCount: devs.length,
        firmwareVersions: versions,
        devices: devs,
        checklist: modelChecklist(profile, versions),
      };
    })
    .sort((a, b) => b.deviceCount - a.deviceCount || a.model.localeCompare(b.model));

  // Global rollout blockers — honest, derived from stored state only.
  const rolloutBlockers: string[] = [];
  if (adapter === "none") {
    rolloutBlockers.push("KIOSK_ADAPTER=none — no gateway adapter exists to deliver a firmware update.");
  } else {
    rolloutBlockers.push(`KIOSK_ADAPTER="${adapter}" selected but no certified adapter implementation is registered — updates cannot be dispatched.`);
  }
  const certified = profiles.filter((p) => p.certification_status === "certified");
  if (certified.length === 0) {
    rolloutBlockers.push("No certified hardware profile on file — device capability claims are unverified.");
  }
  const fwCapable = profiles.filter((p) => p.firmware_update);
  if (fwCapable.length === 0) {
    rolloutBlockers.push("No hardware profile claims firmware_update capability.");
  }
  rolloutBlockers.push("No signed firmware artifact pipeline or vendor signing documentation exists — artifacts cannot be verified or staged.");
  if (models.length === 0) {
    rolloutBlockers.push("No devices registered — nothing to target.");
  }

  return {
    configured: true, adapter, models,
    versionGroups: inv.groups, totalDevices: inv.total,
    rolloutBlockers,
  };
}
