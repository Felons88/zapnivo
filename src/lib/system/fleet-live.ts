/**
 * Pure helpers for the /system/kiosks live-update layer (FleetLive.tsx).
 * Kept framework-free so vitest can cover them without a DOM.
 *
 * Realtime coverage is intentionally narrow: system_devices (heartbeat /
 * status / firmware), system_device_commands (state transitions) and
 * system_device_messages (auth telemetry). All three are in the
 * supabase_realtime publication via migration 0066 and SELECT-restricted to
 * has_system_access() — a subscriber without a system role receives nothing.
 */

export const FLEET_LIVE_TABLES = [
  "system_devices",
  "system_device_commands",
  "system_device_messages",
] as const;
export type FleetLiveTable = (typeof FLEET_LIVE_TABLES)[number];

export const FLEET_LIVE_CHANNEL = "system-fleet-live";
/** Backstop poll — also the ONLY update path when no session token exists. */
export const FLEET_POLL_INTERVAL_MS = 60_000;
/** Data older than this is flagged stale in the UI. */
export const FLEET_REFRESH_STALE_MS = 120_000;

/** postgres_changes bindings — one unfiltered '*' binding per fleet table. */
export function fleetRealtimeBindings(): { event: "*"; schema: "public"; table: FleetLiveTable }[] {
  return FLEET_LIVE_TABLES.map((table) => ({ event: "*" as const, schema: "public" as const, table }));
}

/**
 * True when the last successful refresh is older than `staleAfterMs` (or was
 * never recorded). Used for the honest "data may be stale" note.
 */
export function isFleetDataStale(
  lastRefreshIso: string | null,
  now: Date = new Date(),
  staleAfterMs: number = FLEET_REFRESH_STALE_MS,
): boolean {
  if (!lastRefreshIso) return true;
  const t = new Date(lastRefreshIso).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > staleAfterMs;
}

/** "HH:MM:SSZ" for the stale-data note; "—" when unknown. */
export function formatFleetRefreshTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "—";
  return `${t.toISOString().slice(11, 19)}Z`;
}
