import type { SupabaseClient } from "@supabase/supabase-js";
import { HEARTBEAT_STALE_MIN, heartbeatStale } from "@/lib/kiosk/heartbeat";
import { sanitizePayload } from "./command-ops";
import type { SystemDeviceRow } from "./kiosks";

/**
 * Phase 4.2 — read-only detail helpers for the single-device kiosk page
 * (/system/kiosks/[id]). Everything here is derived from STORED rows only:
 *
 *  - system_devices (registry), system_device_messages (auth telemetry),
 *    device_config_revisions (desired vs reported config),
 *    system_hardware_profiles (certified vendor profile),
 *    system_maintenance_visits (device-level maintenance, migration 0059),
 *    incidents (matched by services tag — there is NO device FK on incidents),
 *    kiosk_slots / power_banks / kiosks / device_events (rental-facing
 *    inventory, bound via kiosks.station_id ↔ device_uid/serial_number).
 *
 * No function in this module claims live hardware contact. Battery pct,
 * reported config, and ack evidence are shown exactly as stored — null stays
 * null ('unknown' at render time), never interpolated.
 */

/* ── Verification-state strip ─────────────────────────────────────────────── */

export type VerificationState = "verified" | "unverified" | "unknown";
export type VerificationBadge = {
  key: "api_reachable" | "gateway_reachable" | "heartbeat_received" | "command_acknowledged" | "physically_verified";
  label: string;
  state: VerificationState;
  detail: string;
};

export type PhysicalCertState = "pass" | "fail" | "none";

/**
 * Derives the top-of-page verification strip. Rules (never infer physical
 * from API reachability):
 *   api_reachable        — always 'verified' here: this function only runs
 *                          while rendering the page server-side.
 *   gateway_reachable    — 'unverified' for adapter none/simulator (no live
 *                          gateway path exists); 'unknown' for any other
 *                          adapter (selected but no live check implemented).
 *   heartbeat_received   — 'verified' only inside HEARTBEAT_STALE_MIN;
 *                          'unverified' when stale; 'unknown' when never seen.
 *   command_acknowledged — 'verified' when a correlated ack timestamp exists;
 *                          'unknown' otherwise (absence is not failure).
 *   physically_verified  — 'verified' only on a PASSING physical-tier
 *                          certification run; 'unverified' on a recorded
 *                          non-pass; 'unknown' when no run exists.
 */
export function buildVerificationStrip(opts: {
  adapter: string;
  lastHeartbeatAt: string | null;
  lastAckAt: string | null;
  physicalCert: PhysicalCertState;
  now?: Date;
}): VerificationBadge[] {
  const now = opts.now ?? new Date();

  const hb = opts.lastHeartbeatAt ? new Date(opts.lastHeartbeatAt).getTime() : NaN;
  const hbState: VerificationState = !Number.isFinite(hb)
    ? "unknown"
    : now.getTime() - hb <= HEARTBEAT_STALE_MIN * 60_000 ? "verified" : "unverified";
  const hbDetail = !Number.isFinite(hb)
    ? "No heartbeat recorded — device has never reported."
    : hbState === "verified"
      ? `Heartbeat within the ${HEARTBEAT_STALE_MIN}-minute staleness window.`
      : `Last heartbeat older than the ${HEARTBEAT_STALE_MIN}-minute staleness window.`;

  const gateway: VerificationBadge =
    opts.adapter === "none"
      ? { key: "gateway_reachable", label: "gateway reachable", state: "unverified", detail: "KIOSK_ADAPTER=none — no gateway link exists to verify." }
      : opts.adapter === "simulator"
        ? { key: "gateway_reachable", label: "gateway reachable", state: "unverified", detail: "Simulator adapter — exercises the control plane only, not real hardware." }
        : { key: "gateway_reachable", label: "gateway reachable", state: "unknown", detail: `Adapter "${opts.adapter}" selected but no live gateway check is implemented.` };

  const physState: VerificationState =
    opts.physicalCert === "pass" ? "verified" : opts.physicalCert === "fail" ? "unverified" : "unknown";
  const physDetail =
    opts.physicalCert === "pass" ? "Latest physical-tier certification run passed."
    : opts.physicalCert === "fail" ? "A physical-tier certification run exists but did not pass."
    : "No physical-tier certification run recorded.";

  return [
    {
      key: "api_reachable", label: "api reachable", state: "verified",
      detail: "Control-plane API reachable — this page rendered server-side.",
    },
    gateway,
    {
      key: "heartbeat_received", label: "heartbeat received", state: hbState, detail: hbDetail,
    },
    {
      key: "command_acknowledged", label: "command acknowledged", state: opts.lastAckAt ? "verified" : "unknown",
      detail: opts.lastAckAt
        ? `Correlated command ack recorded at ${opts.lastAckAt}.`
        : "No correlated command ack on record — absence is not proof of failure.",
    },
    {
      key: "physically_verified", label: "physically verified", state: physState, detail: physDetail,
    },
  ];
}

/* ── Slot / battery inventory projection ──────────────────────────────────── */

export type SlotRow = {
  kiosk_id: string; slot_number: number; state: string; power_bank_id: string | null;
};
export type BankRow = {
  id: string; serial: string | null; battery_pct: number | null;
  current_kiosk: string | null; retired: boolean | null;
};
export type KioskMeta = {
  id: string; station_id: string | null; last_seen_at: string | null;
};

export type SlotView = {
  slot_number: number;
  state: string;
  /** null when the slot references no bank — battery fields stay null, never guessed. */
  bank: { serial: string | null; battery_pct: number | null; retired: boolean } | null;
  /** True when the bank's current_kiosk points at a DIFFERENT kiosk — projection conflict. */
  bank_elsewhere: boolean;
};
export type KioskInventoryView = {
  kiosk_id: string;
  station_id: string | null;
  last_seen_at: string | null;
  /** Stale = kiosk last_seen outside the heartbeat window (or never seen). */
  stale: boolean;
  slots: SlotView[];
};

/**
 * Projects kiosk_slots + power_banks onto each bound kiosk. battery_pct is
 * passed through verbatim (null → render 'unknown'). A bank referenced by a
 * slot but docked elsewhere (current_kiosk mismatch) is flagged, not hidden.
 * `stale` uses the same HEARTBEAT_STALE_MIN window as ingest liveness — it
 * marks the PROJECTION as possibly out of date, it does not claim hardware
 * state.
 */
export function buildSlotInventory(
  slots: SlotRow[],
  banks: BankRow[],
  kiosks: KioskMeta[],
  now = new Date(),
): KioskInventoryView[] {
  const bankById = new Map(banks.map((b) => [b.id, b]));
  const slotsByKiosk = new Map<string, SlotRow[]>();
  for (const s of slots) {
    const list = slotsByKiosk.get(s.kiosk_id) ?? [];
    list.push(s);
    slotsByKiosk.set(s.kiosk_id, list);
  }
  return kiosks.map((k) => ({
    kiosk_id: k.id,
    station_id: k.station_id,
    last_seen_at: k.last_seen_at,
    stale: heartbeatStale(k.last_seen_at, now),
    slots: (slotsByKiosk.get(k.id) ?? [])
      .slice()
      .sort((a, b) => a.slot_number - b.slot_number)
      .map((s) => {
        const bank = s.power_bank_id ? bankById.get(s.power_bank_id) ?? null : null;
        return {
          slot_number: s.slot_number,
          state: s.state,
          bank: bank
            ? { serial: bank.serial ?? null, battery_pct: bank.battery_pct ?? null, retired: bank.retired === true }
            : null,
          bank_elsewhere: bank != null && bank.current_kiosk != null && bank.current_kiosk !== k.id,
        };
      }),
  }));
}

/* ── Device-event payload summary (sanitized) ─────────────────────────────── */

const SUMMARY_KEYS = ["outcome", "error_code", "slot_number", "command_id", "battery_pct", "simulated", "reason"] as const;

/**
 * Short human summary of a device_events payload. Runs through
 * sanitizePayload (secret-shaped keys dropped) then surfaces a fixed set of
 * well-known telemetry keys; anything else collapses to a truncated JSON
 * preview. Never returns raw secrets — sanitizePayload strips them first.
 */
export function summarizeEventPayload(payload: unknown): string {
  const clean = sanitizePayload(payload ?? null) as Record<string, unknown> | null;
  if (!clean || typeof clean !== "object") return "—";
  const parts: string[] = [];
  for (const k of SUMMARY_KEYS) {
    const v = clean[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  if (parts.length > 0) return parts.join(" · ").slice(0, 200);
  const json = JSON.stringify(clean);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

/* ── Desired vs reported config diff ──────────────────────────────────────── */

export type ConfigDiffRow = {
  key: string;
  desired: unknown;
  reported: unknown | null;
  state: "match" | "mismatch" | "no_reported";
};
export type ConfigDiff = {
  rows: ConfigDiffRow[];
  summary: "no_desired" | "no_reported" | "match" | "mismatch";
};

/**
 * Per-key comparison of a revision's desired config against its reported
 * snapshot. reported === null → every row 'no_reported' (there is no
 * reported-config channel in ingest today — honest, not an error).
 */
export function configStateDiff(
  desired: Record<string, unknown> | null | undefined,
  reported: Record<string, unknown> | null | undefined,
): ConfigDiff {
  const d = desired ?? {};
  const keys = Object.keys(d).sort();
  if (keys.length === 0) return { rows: [], summary: "no_desired" };
  if (reported == null) {
    return {
      rows: keys.map((key) => ({ key, desired: d[key], reported: null, state: "no_reported" as const })),
      summary: "no_reported",
    };
  }
  let allMatch = true;
  const rows = keys.map((key) => {
    const match = reported[key] === d[key];
    if (!match) allMatch = false;
    return { key, desired: d[key], reported: reported[key] ?? null, state: match ? "match" as const : "mismatch" as const };
  });
  return { rows, summary: allMatch ? "match" : "mismatch" };
}

/* ── Hardware profile (manufacturer+model match) ──────────────────────────── */

export type HardwareProfileLite = {
  id: string; manufacturer: string; model: string;
  certification_status: string;
  dispense_supported: boolean; return_detection: boolean;
  inventory_reporting: boolean; heartbeat_supported: boolean;
  firmware_update: boolean; ad_screen: boolean;
  protocol_doc_url: string | null;
};

const PROFILE_LITE_SELECT =
  "id,manufacturer,model,certification_status,dispense_supported,return_detection,inventory_reporting,heartbeat_supported,firmware_update,ad_screen,protocol_doc_url";

/**
 * The system_hardware_profiles row matching device manufacturer+model, or
 * null. There is no FK — association is by exact manufacturer+model equality
 * (same rule as resolveDeviceCapabilities). Returns the row regardless of
 * certification_status so the page can show 'uncertified' honestly.
 */
export async function getHardwareProfileForDevice(
  db: SupabaseClient,
  device: Pick<SystemDeviceRow, "manufacturer" | "model">,
): Promise<HardwareProfileLite | null> {
  const manufacturer = device.manufacturer?.trim();
  const model = device.model?.trim();
  if (!manufacturer || !model) return null;
  const { data } = await db.from("system_hardware_profiles")
    .select(PROFILE_LITE_SELECT)
    .eq("manufacturer", manufacturer)
    .eq("model", model)
    .limit(1);
  return ((data ?? [])[0] as HardwareProfileLite | undefined) ?? null;
}

/* ── Auth/message telemetry (system_device_messages, migration 0044) ──────── */

export type DeviceMessageRow = {
  id: string; message_type: string; received_at: string;
  auth_method: string | null; result: string;
  /** Sanitized detail — secret-shaped keys already stripped. */
  detail: Record<string, unknown> | null;
};

export async function listDeviceMessages(
  db: SupabaseClient, deviceId: string, limit = 25,
): Promise<DeviceMessageRow[]> {
  const { data } = await db.from("system_device_messages")
    .select("id,message_type,received_at,auth_method,result,detail")
    .eq("device_id", deviceId)
    .order("received_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return ((data ?? []) as unknown as (Omit<DeviceMessageRow, "detail"> & { detail: unknown })[])
    .map((m) => ({ ...m, detail: sanitizePayload(m.detail ?? null) as Record<string, unknown> | null }));
}

/* ── Device-level maintenance visits (system_maintenance_visits, 0059) ────── */

export type SysMaintenanceRow = {
  id: string; visit_type: string; status: string;
  scheduled_at: string | null; started_at: string | null; completed_at: string | null;
  technician: string | null; notes: string | null; created_at: string;
};

/** Throws on missing table (pre-0059) — callers should .catch(() => []). */
export async function listSystemMaintenanceVisits(
  db: SupabaseClient, deviceId: string, limit = 25,
): Promise<SysMaintenanceRow[]> {
  const { data, error } = await db.from("system_maintenance_visits")
    .select("id,visit_type,status,scheduled_at,started_at,completed_at,technician,notes,created_at")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) throw new Error(error.message);
  return (data ?? []) as SysMaintenanceRow[];
}

/* ── Related incidents ────────────────────────────────────────────────────── */

export type DeviceIncidentRow = {
  id: string; number: string | null; title: string; severity: string; status: string;
  source: string | null; services: string[]; detected_at: string | null; resolved_at: string | null;
};

/**
 * service tags an incident could carry for this device. incidents has NO
 * device FK — the observability pipeline tags `services` with identifiers
 * (alert-sweep emits `device.offline_stale_heartbeat device=<uid>`). We match
 * on device_uid, serial_number, and the row id — all three, deduped.
 */
export function deviceIncidentTags(device: Pick<SystemDeviceRow, "id" | "device_uid" | "serial_number">): string[] {
  return [...new Set([device.device_uid, device.serial_number, device.id].filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/**
 * Incidents whose `services` array contains any device tag. Best-effort and
 * honestly labeled on the page — an empty result means "no incident tagged
 * with this device's identifiers", NOT "device is healthy".
 * Tolerant: returns [] when the incidents table is unreachable/missing.
 */
export async function findDeviceIncidents(
  db: SupabaseClient,
  device: Pick<SystemDeviceRow, "id" | "device_uid" | "serial_number">,
  limit = 20,
): Promise<DeviceIncidentRow[]> {
  const tags = deviceIncidentTags(device);
  if (tags.length === 0) return [];
  const seen = new Set<string>();
  const out: DeviceIncidentRow[] = [];
  for (const tag of tags) {
    const { data, error } = await db.from("incidents")
      .select("id,number,title,severity,status,source,services,detected_at,resolved_at")
      .contains("services", [tag])
      .order("detected_at", { ascending: false })
      .limit(limit);
    if (error) return out.length > 0 ? out : [];
    for (const r of (data ?? []) as DeviceIncidentRow[]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out.sort((a, b) => String(b.detected_at ?? "").localeCompare(String(a.detected_at ?? ""))).slice(0, limit);
}

/* ── Inventory fetch (bound kiosks) ───────────────────────────────────────── */

/**
 * Fetches kiosk_slots + power_banks for a set of bound kiosk ids. Banks are
 * matched BOTH by current_kiosk AND by slot.power_bank_id references (a bank
 * can be slot-assigned while current_kiosk is null/stale — both views are
 * kept and conflicts flagged in buildSlotInventory).
 */
export async function listInventoryForKiosks(
  db: SupabaseClient, kioskIds: string[],
): Promise<{ slots: SlotRow[]; banks: BankRow[] }> {
  if (kioskIds.length === 0) return { slots: [], banks: [] };
  const { data: slotData } = await db.from("kiosk_slots")
    .select("kiosk_id,slot_number,state,power_bank_id")
    .in("kiosk_id", kioskIds)
    .limit(2000);
  const slots = (slotData ?? []) as SlotRow[];
  const bankIds = [...new Set(slots.map((s) => s.power_bank_id).filter((v): v is string => typeof v === "string" && v.length > 0))];
  const [byKiosk, byId] = await Promise.all([
    db.from("power_banks").select("id,serial,battery_pct,current_kiosk,retired").in("current_kiosk", kioskIds).limit(2000),
    bankIds.length > 0
      ? db.from("power_banks").select("id,serial,battery_pct,current_kiosk,retired").in("id", bankIds).limit(2000)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const seen = new Set<string>();
  const banks: BankRow[] = [];
  for (const b of [...((byKiosk.data ?? []) as BankRow[]), ...((byId.data ?? []) as BankRow[])]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    banks.push(b);
  }
  return { slots, banks };
}
