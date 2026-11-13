/**
 * Client-safe constants/types for device configuration + maintenance visits.
 * Kept free of server-only imports (supabase, audit, auth) so "use client"
 * components can consume them. src/lib/system/device-config.ts re-exports
 * these for server callers — import from there on the server.
 */

export const MAINTENANCE_VISIT_TYPES = ["routine", "repair", "firmware", "inspection", "other"] as const;
export type MaintenanceVisitType = (typeof MAINTENANCE_VISIT_TYPES)[number];

export const MAINTENANCE_STATUSES = ["open", "scheduled", "in_progress", "completed", "cancelled"] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Allowed status edges. completed/cancelled are terminal. */
export const MAINTENANCE_TRANSITIONS: Record<MaintenanceStatus, readonly MaintenanceStatus[]> = {
  open: ["scheduled", "in_progress", "cancelled"],
  scheduled: ["in_progress", "cancelled", "open"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export type MaintenanceVisitRow = {
  id: string; device_id: string; visit_type: MaintenanceVisitType; status: MaintenanceStatus;
  scheduled_at: string | null; started_at: string | null; completed_at: string | null;
  technician: string | null; notes: string | null; created_by: string | null;
  created_at: string; updated_at: string;
};

export const MAINTENANCE_VISIT_SELECT =
  "id,device_id,visit_type,status,scheduled_at,started_at,completed_at,technician,notes,created_by,created_at,updated_at";

export function canTransitionVisit(from: MaintenanceStatus, to: MaintenanceStatus): boolean {
  return MAINTENANCE_TRANSITIONS[from]?.includes(to) ?? false;
}
