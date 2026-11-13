import type { SupabaseClient } from "@supabase/supabase-js";
import { HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { deviceCredentialStatus, type DeviceAuthRow, type CredentialStatus } from "./device-auth";
import {
  deriveConnectivity, isSystemDeviceStatus, SYSTEM_DEVICE_SELECT,
  type FleetDevice, type SystemDeviceRow, type SystemDeviceStatus,
} from "./kiosks";
import { configStateDiff } from "./kiosk-detail";

/**
 * Fleet-wide aggregates + filtered listing for the System Control kiosk
 * registry. Every number is a real DB count — sections that fail return null
 * (honest "unknown"), never a fabricated zero.
 *
 * Connectivity uses the same stored-timestamp derivation as the fleet table
 * (deriveConnectivity / HEARTBEAT_STALE_MIN) — "online" only means a heartbeat
 * was recorded inside the staleness window; there is no live ping.
 *
 * "Faulted" = the device's bound rental-facing kiosk(s) (kiosks.station_id ↔
 * system_devices.device_uid/serial_number — the same binding ingest uses)
 * recorded a hardware_fault device_event in the last FAULT_WINDOW_DAYS days
 * or currently have a kiosk_slots row in state 'fault'.
 */

export const FLEET_STATS_DEVICE_LIMIT = 1000;
export const FLEET_STATS_RUN_LIMIT = 5000;
export const FLEET_STATS_EVENT_LIMIT = 5000;
export const FAULT_WINDOW_DAYS = 7;

/** Columns needed for stats — credential fields feed deviceCredentialStatus. */
const STATS_SELECT =
  "id,status,last_heartbeat_at,firmware_version,venue_id,region," +
  "auth_method,device_secret_hash,device_secret_enc,device_secret_enc_next," +
  "credential_issued_at,credential_expires_at,credential_revoked_at," +
  "last_authed_at,last_message_ts";

type StatsDeviceRow = {
  id: string; status: SystemDeviceStatus | string;
  last_heartbeat_at: string | null; firmware_version: string | null;
  venue_id: string | null; region: string | null;
  auth_method: string | null; device_secret_hash: string | null;
  device_secret_enc?: string | null; device_secret_enc_next?: string | null;
  credential_issued_at: string | null; credential_expires_at: string | null;
  credential_revoked_at: string | null;
  last_authed_at: string | null; last_message_ts: number | string | null;
};

export type FleetConnectivityCounts = { online: number; stale: number; no_data: number };

export type FleetStats = {
  /** When the snapshot was computed (server time). */
  computed_at: string;
  total: number;
  /** Device count per lifecycle status (absent statuses = 0, omitted). */
  by_status: Partial<Record<SystemDeviceStatus, number>>;
  connectivity: FleetConnectivityCounts;
  /** Devices with recent hardware_fault events or faulted slots (bound kiosks). */
  faulted: number | null;
  /** system_device_commands still open (pending|sent). */
  pending_commands: number | null;
  credential_issues: {
    expired: number; revoked: number; pending: number;
    /** Live zero-downtime rotation windows or overdue staged slots. */
    rotation_pending: number; rotation_overdue: number;
  } | null;
  /** Latest certification run per (device, tier) → status counts per tier. */
  certification: { tiers: Record<string, Record<string, number>> } | null;
  /** firmware_version → device count ("unknown" for null). */
  firmware: Record<string, number> | null;
  /** region → device count ("unassigned" for null). */
  regions: Record<string, number> | null;
  /** venue name (or id fallback) → device count ("unassigned" for null). */
  venues: Record<string, number> | null;
  /**
   * Maintenance (0059): `devices` = system_devices.status='maintenance' (from
   * the authoritative scan — never null); `open_visits` = system_maintenance_visits
   * in a non-terminal state (open|scheduled|in_progress), null on query failure.
   */
  maintenance: { devices: number; open_visits: number | null } | null;
  /** Devices still in the onboarding pipeline: pending|registered|provisioning. */
  provisioning_pending: number;
  /**
   * Certification has NO running/pending run state (0051 statuses are
   * pass|fail|blocked|skipped), so there is nothing "active" to count.
   * Instead: `without_pass` = devices with ≥1 run whose LATEST status in at
   * least one tier is not 'pass'; `never_tested` = devices with zero runs.
   */
  certification_active: { without_pass: number; never_tested: number } | null;
  /** Rejected device ingest auth attempts in the last 24h (system_device_messages). */
  auth_failures: number | null;
  /**
   * system_device_commands that reached 'failed'/'timeout' with created_at in
   * the last 24h. (The table has no resolved-at column, so the window is on
   * created_at — a command created earlier but failed recently is NOT counted;
   * documented limitation, not a hidden approximation.)
   */
  command_outcomes_24h: { failed: number; timeout: number } | null;
  /**
   * Latest device_config_revisions row per device (0059):
   * `mismatched` = a reported snapshot exists and differs from desired on ≥1
   * whitelisted key; `awaiting_report` = latest revision still awaiting device
   * confirmation. reported==null is "unreported", NOT drift — never counted.
   */
  config_drift: { mismatched: number; awaiting_report: number } | null;
  /**
   * LEGACY rental-fleet battery/inventory snapshot (kiosks/kiosk_slots/
   * power_banks, migration 0001) — NOT system_devices. The two fleets bind only
   * via kiosks.station_id ↔ system_devices.device_uid/serial_number, so this
   * section describes the rental-facing hardware estate on its own terms.
   * `kiosks_stale` uses the same HEARTBEAT_STALE_MIN window as device
   * connectivity (null last_seen_at counts as stale — never seen).
   */
  battery_inventory: {
    kiosks_total: number; kiosks_stale: number;
    slots_by_state: Record<string, number>;
    banks_total: number; banks_retired: number; banks_unknown_pct: number;
  } | null;
  /** rental_exceptions not in a terminal state (resolved|dismissed excluded). */
  open_exceptions: number | null;
  /** Sections that could not be computed — honest partial-failure signal. */
  errors: string[];
};

const bump = (rec: Record<string, number>, key: string) => { rec[key] = (rec[key] ?? 0) + 1; };

function credentialIssueKind(s: CredentialStatus): keyof NonNullable<FleetStats["credential_issues"]> | null {
  switch (s.state) {
    case "expired": return "expired";
    case "revoked": return "revoked";
    case "pending": return "pending";
    case "active":
      if (s.rotationOverdue) return "rotation_overdue";
      if (s.rotationPending) return "rotation_pending";
      return null;
    default: return null;
  }
}

/** Latest status per device for ONE tier (for the fleet certification filter). */
export function certificationStatusByDevice(
  runs: { device_id: string | null; tier: string; status: string; created_at: string }[],
  tier: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of runs) {
    if (!r.device_id || r.tier !== tier || seen.has(r.device_id)) continue;
    seen.add(r.device_id);
    out.set(r.device_id, r.status);
  }
  return out;
}

export type FleetFilter = {
  status?: string;
  venue_id?: string;
  region?: string;
  /** online | stale | no_data — derived from stored heartbeats only. */
  connectivity?: string;
  /** e.g. cert_tier=physical&cert_status=pass → device's LATEST run for that tier. */
  cert_tier?: string;
  cert_status?: string;
  limit?: number;
};

/**
 * Filtered fleet listing. DB-side filters: status/venue/region. Post-filters
 * (connectivity, certification) run in JS over the bounded candidate set —
 * documented so callers know the limit applies BEFORE post-filtering.
 */
export async function listFleetDevicesFiltered(
  db: SupabaseClient,
  f: FleetFilter = {},
  now = new Date(),
): Promise<{ devices: FleetDevice[]; error?: string; truncated?: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? 300, 1), FLEET_STATS_DEVICE_LIMIT);
  let q = db
    .from("system_devices")
    .select(`${SYSTEM_DEVICE_SELECT},venues(id,name,city)`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (f.status && isSystemDeviceStatus(f.status)) q = q.eq("status", f.status);
  if (f.venue_id) q = q.eq("venue_id", f.venue_id);
  if (f.region) q = q.eq("region", f.region);
  const { data, error } = await q;
  if (error) return { devices: [], error: error.message };
  const truncated = (data ?? []).length >= limit;
  let devices = ((data ?? []) as (SystemDeviceRow & { venues: { id: string; name: string | null; city: string | null } | { id: string; name: string | null; city: string | null }[] | null })[])
    .map((d) => {
      const v = Array.isArray(d.venues) ? d.venues[0] ?? null : d.venues ?? null;
      const { venues: _drop, ...rest } = d as SystemDeviceRow & { venues?: unknown };
      return { ...rest, venue: v } as FleetDevice;
    });

  if (f.connectivity === "online" || f.connectivity === "stale" || f.connectivity === "no_data") {
    devices = devices.filter((d) => deriveConnectivity(d, now).kind === f.connectivity);
  }

  if (f.cert_tier && f.cert_status) {
    const { data: runs, error: certErr } = await db
      .from("system_certification_runs")
      .select("device_id,tier,status,created_at")
      .eq("tier", f.cert_tier)
      .order("created_at", { ascending: false })
      .limit(FLEET_STATS_RUN_LIMIT);
    if (certErr) return { devices: [], error: certErr.message };
    const byDevice = certificationStatusByDevice(
      (runs ?? []) as { device_id: string | null; tier: string; status: string; created_at: string }[],
      f.cert_tier,
    );
    devices = devices.filter((d) => byDevice.get(d.id) === f.cert_status);
  }

  return { devices, truncated };
}

/**
 * Computes the fleet stats snapshot. Never throws for section failures —
 * each section is independently guarded and reported in `errors`.
 */
export async function getFleetStats(db: SupabaseClient, now = new Date()): Promise<FleetStats | { error: string }> {
  const errors: string[] = [];

  // ── Devices (authoritative section — failure fails the whole snapshot) ──
  const { data: devData, error: devErr } = await db
    .from("system_devices")
    .select(STATS_SELECT)
    .order("created_at", { ascending: false })
    .limit(FLEET_STATS_DEVICE_LIMIT);
  if (devErr) return { error: devErr.message };
  const devices = (devData ?? []) as unknown as StatsDeviceRow[];
  const truncated = devices.length >= FLEET_STATS_DEVICE_LIMIT;
  if (truncated) errors.push(`device scan truncated at ${FLEET_STATS_DEVICE_LIMIT} rows`);

  const by_status: Partial<Record<SystemDeviceStatus, number>> = {};
  const connectivity: FleetConnectivityCounts = { online: 0, stale: 0, no_data: 0 };
  const firmware: Record<string, number> = {};
  const regions: Record<string, number> = {};
  const venueIds = new Set<string>();

  for (const d of devices) {
    if (isSystemDeviceStatus(d.status)) bump(by_status as Record<string, number>, d.status);
    const conn = deriveConnectivity({ last_heartbeat_at: d.last_heartbeat_at, last_message_at: null }, now);
    connectivity[conn.kind === "online" ? "online" : conn.kind === "stale" ? "stale" : "no_data"] += 1;
    bump(firmware, d.firmware_version ?? "unknown");
    bump(regions, d.region ?? "unassigned");
    if (d.venue_id) venueIds.add(d.venue_id);
  }

  // Venue names for the breakdown (single bounded lookup).
  const venues: Record<string, number> = {};
  if (venueIds.size > 0) {
    const { data: vData, error: vErr } = await db.from("venues").select("id,name").in("id", [...venueIds]);
    if (vErr) errors.push(`venues: ${vErr.message}`);
    const names = new Map(((vData ?? []) as { id: string; name: string | null }[]).map((v) => [v.id, v.name ?? v.id.slice(0, 8)]));
    for (const d of devices) {
      if (!d.venue_id) continue;
      bump(venues, names.get(d.venue_id) ?? `${d.venue_id.slice(0, 8)} (deleted?)`);
    }
  }
  let unassignedVenues = 0;
  for (const d of devices) if (!d.venue_id) unassignedVenues += 1;
  if (unassignedVenues > 0) venues["unassigned"] = unassignedVenues;

  // ── Pending commands ──
  let pendingCommands: number | null = null;
  try {
    const { data, error } = await db.from("system_device_commands").select("id").in("state", ["pending", "sent"]).limit(FLEET_STATS_EVENT_LIMIT);
    if (error) throw new Error(error.message);
    pendingCommands = (data ?? []).length;
    if ((data ?? []).length >= FLEET_STATS_EVENT_LIMIT) errors.push("pending command count truncated");
  } catch (e) { errors.push(`pending_commands: ${e instanceof Error ? e.message : "failed"}`); }

  // ── Credential issues ──
  let credentialIssues: FleetStats["credential_issues"] = null;
  try {
    const acc = { expired: 0, revoked: 0, pending: 0, rotation_pending: 0, rotation_overdue: 0 };
    // Full credential columns incl. rotation-window fields (enc values are
    // consumed by deviceCredentialStatus as presence flags only — the raw
    // ciphertext is never returned by this module).
    const { data: credData, error: credErr } = await db
      .from("system_devices")
      .select("id,auth_method,device_secret_hash,device_secret_enc,device_secret_enc_next,credential_next_expires_at,credential_issued_at,credential_expires_at,credential_revoked_at,last_authed_at,last_message_ts")
      .limit(FLEET_STATS_DEVICE_LIMIT);
    if (credErr) throw new Error(credErr.message);
    for (const raw of (credData ?? []) as DeviceAuthRow[]) {
      const kind = credentialIssueKind(deviceCredentialStatus(raw, now));
      if (kind) acc[kind] += 1;
    }
    credentialIssues = acc;
  } catch (e) { errors.push(`credential_issues: ${e instanceof Error ? e.message : "failed"}`); }

  // ── Certification breakdown (latest per device+tier) ──
  let certification: FleetStats["certification"] = null;
  let certificationActive: FleetStats["certification_active"] = null;
  try {
    const { data, error } = await db
      .from("system_certification_runs")
      .select("device_id,tier,status,created_at")
      .order("created_at", { ascending: false })
      .limit(FLEET_STATS_RUN_LIMIT);
    if (error) throw new Error(error.message);
    const runs = (data ?? []) as { device_id: string | null; tier: string; status: string; created_at: string }[];
    const tiers: Record<string, Record<string, number>> = {};
    const seen = new Set<string>();
    // device_id → tier → latest status (first-seen wins; rows are created_at desc).
    const latestByDeviceTier = new Map<string, Map<string, string>>();
    for (const r of runs) {
      if (!r.device_id) continue;
      const key = `${r.device_id}${r.tier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bump((tiers[r.tier] ??= {}), r.status);
      let m = latestByDeviceTier.get(r.device_id);
      if (!m) latestByDeviceTier.set(r.device_id, (m = new Map()));
      m.set(r.tier, r.status);
    }
    certification = { tiers };
    // No 'running'/'pending' run state exists (0051) — report certification
    // coverage honestly instead: devices not passing on every tested tier,
    // and devices that have never been tested at all.
    let withoutPass = 0;
    let neverTested = 0;
    for (const d of devices) {
      const perTier = latestByDeviceTier.get(d.id);
      if (!perTier) { neverTested += 1; continue; }
      for (const st of perTier.values()) {
        if (st !== "pass") { withoutPass += 1; break; }
      }
    }
    certificationActive = { without_pass: withoutPass, never_tested: neverTested };
    if (runs.length >= FLEET_STATS_RUN_LIMIT) errors.push("certification scan truncated");
  } catch (e) { errors.push(`certification: ${e instanceof Error ? e.message : "failed"}`); }

  // ── Faulted devices (bound kiosks → device_events / kiosk_slots) ──
  let faulted: number | null = null;
  try {
    const since = new Date(now.getTime() - FAULT_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: ks, error: kErr } = await db.from("kiosks").select("id,station_id").limit(FLEET_STATS_EVENT_LIMIT);
    if (kErr) throw new Error(kErr.message);
    const stationToDevice = new Map<string, string>();
    // device_uid/serial_number aren't in STATS_SELECT — fetch them cheaply.
    const { data: idRows, error: idErr } = await db
      .from("system_devices").select("id,device_uid,serial_number").limit(FLEET_STATS_DEVICE_LIMIT);
    if (idErr) throw new Error(idErr.message);
    for (const r of (idRows ?? []) as { id: string; device_uid: string | null; serial_number: string | null }[]) {
      if (r.device_uid) stationToDevice.set(r.device_uid, r.id);
      if (r.serial_number) stationToDevice.set(r.serial_number, r.id);
    }
    const kioskToDevice = new Map<string, string>();
    for (const k of (ks ?? []) as { id: string; station_id: string | null }[]) {
      if (!k.station_id) continue;
      const devId = stationToDevice.get(k.station_id);
      if (devId) kioskToDevice.set(k.id, devId);
    }
    const kioskIds = [...kioskToDevice.keys()];
    const faultedDevices = new Set<string>();
    if (kioskIds.length > 0) {
      const [evRes, slotRes] = await Promise.all([
        db.from("device_events").select("kiosk_id").in("kiosk_id", kioskIds).eq("event_type", "hardware_fault").gte("occurred_at", since).limit(FLEET_STATS_EVENT_LIMIT),
        db.from("kiosk_slots").select("kiosk_id").in("kiosk_id", kioskIds).eq("state", "fault").limit(FLEET_STATS_EVENT_LIMIT),
      ]);
      if (evRes.error) throw new Error(evRes.error.message);
      if (slotRes.error) throw new Error(slotRes.error.message);
      for (const e of (evRes.data ?? []) as { kiosk_id: string }[]) {
        const dev = kioskToDevice.get(e.kiosk_id); if (dev) faultedDevices.add(dev);
      }
      for (const s of (slotRes.data ?? []) as { kiosk_id: string }[]) {
        const dev = kioskToDevice.get(s.kiosk_id); if (dev) faultedDevices.add(dev);
      }
    }
    faulted = faultedDevices.size;
  } catch (e) { errors.push(`faulted: ${e instanceof Error ? e.message : "failed"}`); }

  // ── Phase 4.2 ops sections (each independently guarded) ──
  const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  // Maintenance: device count comes from the authoritative scan; the visits
  // count is a separate guarded query (null on failure, never a fake zero).
  let maintenance: FleetStats["maintenance"] = null;
  try {
    const { data, error } = await db
      .from("system_maintenance_visits")
      .select("id")
      .in("status", ["open", "scheduled", "in_progress"])
      .limit(FLEET_STATS_EVENT_LIMIT);
    if (error) throw new Error(error.message);
    const n = (data ?? []).length;
    if (n >= FLEET_STATS_EVENT_LIMIT) errors.push("open maintenance visits truncated");
    maintenance = { devices: by_status.maintenance ?? 0, open_visits: n };
  } catch (e) {
    errors.push(`maintenance: ${e instanceof Error ? e.message : "failed"}`);
    maintenance = { devices: by_status.maintenance ?? 0, open_visits: null };
  }

  // Devices still in the onboarding pipeline (derived from the device scan —
  // cannot fail independently).
  const provisioningPending =
    (by_status.pending ?? 0) + (by_status.registered ?? 0) + (by_status.provisioning ?? 0);

  // Rejected device ingest auth attempts in the last 24h.
  let authFailures: number | null = null;
  try {
    const { data, error } = await db
      .from("system_device_messages")
      .select("id")
      .eq("result", "rejected")
      .gte("received_at", since24h)
      .limit(FLEET_STATS_EVENT_LIMIT);
    if (error) throw new Error(error.message);
    authFailures = (data ?? []).length;
    if ((data ?? []).length >= FLEET_STATS_EVENT_LIMIT) errors.push("auth failure count truncated");
  } catch (e) { errors.push(`auth_failures: ${e instanceof Error ? e.message : "failed"}`); }

  // Commands that ended failed/timeout in the last 24h (window on created_at —
  // see FleetStats.command_outcomes_24h doc for the limitation).
  let commandOutcomes: FleetStats["command_outcomes_24h"] = null;
  try {
    const { data, error } = await db
      .from("system_device_commands")
      .select("state")
      .in("state", ["failed", "timeout"])
      .gte("created_at", since24h)
      .limit(FLEET_STATS_EVENT_LIMIT);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { state: string }[];
    commandOutcomes = {
      failed: rows.filter((r) => r.state === "failed").length,
      timeout: rows.filter((r) => r.state === "timeout").length,
    };
    if (rows.length >= FLEET_STATS_EVENT_LIMIT) errors.push("command outcome count truncated");
  } catch (e) { errors.push(`command_outcomes_24h: ${e instanceof Error ? e.message : "failed"}`); }

  // Config drift: latest device_config_revisions row per device. Rows arrive
  // ordered by revision desc, so the first row seen per device is its latest.
  let configDrift: FleetStats["config_drift"] = null;
  try {
    const { data, error } = await db
      .from("device_config_revisions")
      .select("device_id,revision,desired,status,reported")
      .order("revision", { ascending: false })
      .limit(FLEET_STATS_RUN_LIMIT);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { device_id: string; revision: number; desired: Record<string, unknown>; status: string; reported: Record<string, unknown> | null }[];
    const latestSeen = new Set<string>();
    let mismatched = 0;
    let awaitingReport = 0;
    for (const r of rows) {
      if (latestSeen.has(r.device_id)) continue;
      latestSeen.add(r.device_id);
      if (r.status === "awaiting_report") awaitingReport += 1;
      // reported === null → "unreported", not drift (no reported-config
      // channel exists in ingest today — see 0059/device-config.ts).
      if (r.reported != null && configStateDiff(r.desired, r.reported).summary === "mismatch") mismatched += 1;
    }
    configDrift = { mismatched, awaiting_report: awaitingReport };
    if (rows.length >= FLEET_STATS_RUN_LIMIT) errors.push("config revision scan truncated");
  } catch (e) { errors.push(`config_drift: ${e instanceof Error ? e.message : "failed"}`); }

  // Battery/inventory snapshot of the LEGACY rental fleet (kiosks +
  // kiosk_slots + power_banks). system_devices is a separate registry — the
  // only link is kiosks.station_id ↔ device_uid/serial_number, so these
  // counts describe rental-facing hardware independently (see type doc).
  let batteryInventory: FleetStats["battery_inventory"] = null;
  try {
    const [kRes, sRes, bRes] = await Promise.all([
      db.from("kiosks").select("id,last_seen_at").limit(FLEET_STATS_EVENT_LIMIT),
      db.from("kiosk_slots").select("kiosk_id,state").limit(FLEET_STATS_EVENT_LIMIT),
      db.from("power_banks").select("id,battery_pct,retired").limit(FLEET_STATS_EVENT_LIMIT),
    ]);
    if (kRes.error) throw new Error(kRes.error.message);
    if (sRes.error) throw new Error(sRes.error.message);
    if (bRes.error) throw new Error(bRes.error.message);
    const kiosks = (kRes.data ?? []) as { id: string; last_seen_at: string | null }[];
    const slots = (sRes.data ?? []) as { kiosk_id: string; state: string }[];
    const banks = (bRes.data ?? []) as { id: string; battery_pct: number | null; retired: boolean }[];
    const staleBefore = now.getTime() - HEARTBEAT_STALE_MIN * 60_000;
    let kiosksStale = 0;
    for (const k of kiosks) {
      const t = k.last_seen_at ? new Date(k.last_seen_at).getTime() : NaN;
      if (!Number.isFinite(t) || t < staleBefore) kiosksStale += 1;
    }
    const slotsByState: Record<string, number> = {};
    for (const s of slots) bump(slotsByState, s.state ?? "unknown");
    batteryInventory = {
      kiosks_total: kiosks.length,
      kiosks_stale: kiosksStale,
      slots_by_state: slotsByState,
      banks_total: banks.length,
      banks_retired: banks.filter((b) => b.retired === true).length,
      banks_unknown_pct: banks.filter((b) => b.battery_pct == null).length,
    };
    for (const [label, n] of [["kiosks", kiosks.length], ["kiosk_slots", slots.length], ["power_banks", banks.length]] as const) {
      if (n >= FLEET_STATS_EVENT_LIMIT) errors.push(`battery_inventory ${label} truncated`);
    }
  } catch (e) { errors.push(`battery_inventory: ${e instanceof Error ? e.message : "failed"}`); }

  // Open rental exceptions (0054: terminal = resolved|dismissed).
  let openExceptions: number | null = null;
  try {
    const { data, error } = await db
      .from("rental_exceptions")
      .select("status")
      .limit(FLEET_STATS_EVENT_LIMIT);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { status: string }[];
    openExceptions = rows.filter((r) => r.status !== "resolved" && r.status !== "dismissed").length;
    if (rows.length >= FLEET_STATS_EVENT_LIMIT) errors.push("rental_exceptions scan truncated");
  } catch (e) { errors.push(`open_exceptions: ${e instanceof Error ? e.message : "failed"}`); }

  return {
    computed_at: now.toISOString(),
    total: devices.length,
    by_status,
    connectivity,
    faulted,
    pending_commands: pendingCommands,
    credential_issues: credentialIssues,
    certification,
    firmware,
    regions,
    venues,
    maintenance,
    provisioning_pending: provisioningPending,
    certification_active: certificationActive,
    auth_failures: authFailures,
    command_outcomes_24h: commandOutcomes,
    config_drift: configDrift,
    battery_inventory: batteryInventory,
    open_exceptions: openExceptions,
    errors,
  };
}

export { HEARTBEAT_STALE_MIN };
