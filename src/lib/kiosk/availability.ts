import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side rental availability gate for kiosk maintenance.
 *
 * The customer-facing `kiosks.state` check lives in the checkout route; this
 * module adds the CONTROL-PLANE signals that must ALSO block a new rental:
 *
 *  1. `system_devices.status` ∈ NON_SERVING_DEVICE_STATUSES — the fleet
 *     registry lifecycle (maintenance | suspended | quarantined |
 *     decommissioned). pending/registered/provisioning are NOT blocked here:
 *     the rental-facing kiosks.state='online' gate already governs whether a
 *     station is live, and fleet registration can lag field deployment.
 *  2. An OPEN `system_maintenance_visits` row (open | scheduled | in_progress)
 *     for the bound device — scheduling maintenance blocks new rentals even
 *     before the device status flips to 'maintenance'.
 *  3. `device_config_revisions` desired-state `maintenance_mode: true` on the
 *     LATEST revision whose status is approved | awaiting_report | applied —
 *     an accepted ops intent to take the device out of service. Drafts,
 *     failed and superseded revisions do NOT block (the intent was never
 *     accepted for the field, or was replaced).
 *
 * Device binding: `station_id` resolves to a `system_devices` row by
 * `device_uid` OR `serial_number` — the same binding /api/devices/events
 * enforces (spec §1, docs/HARDWARE-GATEWAY-SPEC.md). A station with NO
 * system_devices row returns null: there is no control-plane maintenance
 * signal to enforce, and the legacy kiosks.state gate still applies.
 *
 * This gate is SERVER-SIDE and unconditional — it does not depend on the
 * device acknowledging anything. Device-side enforcement (the kiosk itself
 * refusing dispense) additionally requires a live adapter
 * (KIOSK_ADAPTER=none today — see docs/GATEWAY-ADAPTER.md).
 */

export type MaintenanceBlockReason = "device_status" | "maintenance_visit" | "maintenance_config";

export type MaintenanceBlock = {
  reason: MaintenanceBlockReason;
  /** Human/log detail — never shown raw to customers. */
  detail: string;
};

/** system_devices statuses that must not serve new rentals. */
export const NON_SERVING_DEVICE_STATUSES = [
  "maintenance", "suspended", "quarantined", "decommissioned",
] as const;

/** Maintenance visit statuses that mean "maintenance is booked or underway". */
export const OPEN_MAINTENANCE_VISIT_STATUSES = ["open", "scheduled", "in_progress"] as const;

/** Config revision statuses where desired.maintenance_mode is an accepted ops intent. */
export const MAINTENANCE_CONFIG_ACTIVE_STATUSES = ["approved", "awaiting_report", "applied"] as const;

const DEVICE_SELECT = "id,status";

type DeviceRef = { id: string; status: string };

/** Finds the system_devices row bound to a rental-facing station_id. */
async function findStationDevice(db: SupabaseClient, stationId: string): Promise<DeviceRef | null> {
  // Same safe-char guard as /api/devices/events findStationDevice.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(stationId)) return null;
  const byUid = await db.from("system_devices").select(DEVICE_SELECT)
    .eq("device_uid", stationId).limit(1);
  const uidRow = ((byUid.data ?? []) as DeviceRef[])[0];
  if (uidRow) return uidRow;
  const bySerial = await db.from("system_devices").select(DEVICE_SELECT)
    .eq("serial_number", stationId).limit(1);
  return ((bySerial.data ?? []) as DeviceRef[])[0] ?? null;
}

/**
 * Returns the maintenance block for a station, or null when the station may
 * serve a new rental (from the control-plane perspective). Read-only — never
 * mutates state.
 */
export async function stationMaintenanceBlock(
  db: SupabaseClient,
  stationId: string,
): Promise<MaintenanceBlock | null> {
  const device = await findStationDevice(db, stationId);
  if (!device) return null; // no fleet row — nothing control-plane to enforce

  if ((NON_SERVING_DEVICE_STATUSES as readonly string[]).includes(device.status)) {
    return { reason: "device_status", detail: `system_devices.status='${device.status}'` };
  }

  const { data: visits } = await db.from("system_maintenance_visits")
    .select("id")
    .eq("device_id", device.id)
    .in("status", [...OPEN_MAINTENANCE_VISIT_STATUSES])
    .limit(1);
  if (Array.isArray(visits) && visits.length > 0) {
    return { reason: "maintenance_visit", detail: "open/scheduled/in_progress maintenance visit on file" };
  }

  // Effective desired-state = the NEWEST revision in an accepted status
  // (approved | awaiting_report | applied). Drafts/failed/superseded are skipped:
  // a draft proposing to exit maintenance must not unblock until it is itself
  // accepted and applied, and a failed dispatch never took effect.
  const { data: revs } = await db.from("device_config_revisions")
    .select("desired,status")
    .eq("device_id", device.id)
    .order("revision", { ascending: false })
    .limit(10);
  const latest = ((revs ?? []) as { desired?: Record<string, unknown> | null; status?: string }[])
    .find((r) => (MAINTENANCE_CONFIG_ACTIVE_STATUSES as readonly string[]).includes(r.status ?? ""));
  if (latest?.desired?.maintenance_mode === true) {
    return { reason: "maintenance_config", detail: `accepted config revision (${latest.status}) sets maintenance_mode=true` };
  }

  return null;
}
