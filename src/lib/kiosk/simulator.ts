import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KioskAdapter, DispenseRequest, DispenseResult, KioskHealth, SlotStatus } from "./adapter";
import { ingestBodySchema, ingestKioskEvents, type IngestBody } from "./ingest";
import {
  signDeviceRequest, verifyDeviceAuth,
} from "@/lib/system/device-auth";
import { issueProvisionToken, type SystemDeviceRow } from "@/lib/system/kiosks";
import { redeemProvisionToken } from "@/lib/system/provisioning";
import type { SystemActor } from "@/lib/system/audit";

/**
 * Mock kiosk + lifecycle simulator. Lets the full dispense → activate → return flow run in
 * tests without hardware. The simulator emits the same event shape the ingest route accepts,
 * so tests exercise the real pipeline (ingestKioskEvents / processKioskEvent) end to end.
 *
 * Phase 2.5 — full lifecycle + HMAC transport:
 *  - Every event the simulator emits carries `simulated: true` (forced in `push`,
 *    cannot be overridden). Synthetic telemetry is NEVER hardware truth.
 *  - `SimDeviceSession` reproduces the HTTP contract of POST /api/devices/events
 *    in-process: it signs the raw body with the device credential
 *    (signDeviceRequest → verifyDeviceAuth), enforces the station binding, and
 *    runs ingestKioskEvents — the same code path the route executes.
 *  - `createSimEnvironment` provisions a complete sim stack (system_devices row
 *    in the `sim-` namespace → provisioning token → redeemProvisionToken →
 *    credential → active → kiosks row) using ONLY the real lib functions.
 *    Sim rows are namespaced (`sim-` device_uid, `SIM-` station/serial,
 *    `ZR-SIM-` rental refs, `SIM-BANK-` bank serials) and carry
 *    capabilities.simulated=true — they never touch production device rows.
 *
 * HONESTY NOTE (known gap, documented): `simulated` on an ingest event is
 * self-reported by the client. The server stores it verbatim but cannot
 * cryptographically distinguish a simulated event from a physical one — the
 * only server-side marker is the device row itself (capabilities.simulated /
 * sim- namespace), which the certification runner checks before recording.
 */
export class MockKioskAdapter implements KioskAdapter {
  readonly name = "simulator";
  /** Bank ids available to dispense, FIFO. */
  banks: string[] = [];
  slots = new Map<number, { status: SlotStatus; powerBankId?: string }>();
  dispenseCalls: DispenseRequest[] = [];
  failWith: DispenseResult | null = null;
  online = true;
  lastSeenAt: string | null = null;

  constructor(private stationId = "SIM-001") {}

  async health(_stationId: string): Promise<KioskHealth | null> {
    if (!this.online) return { stationId: this.stationId, online: false, lastSeenAt: this.lastSeenAt, slots: [] };
    return {
      stationId: this.stationId, online: true, lastSeenAt: this.lastSeenAt,
      slots: [...this.slots.entries()].sort((a, b) => a[0] - b[0])
        .map(([slot, s]) => ({ slot, status: s.status, ...(s.powerBankId ? { powerBankId: s.powerBankId } : {}) })),
    };
  }

  async dispense(req: DispenseRequest): Promise<DispenseResult> {
    this.dispenseCalls.push(req);
    if (this.failWith) return this.failWith;
    if (!this.online) return { status: "failed", reason: "offline" };
    const powerBankId = this.banks.shift();
    if (!powerBankId) return { status: "failed", reason: "no_inventory" };
    const slot = this.freeSlot();
    if (slot == null) return { status: "failed", reason: "hardware_fault" };
    this.slots.set(slot, { status: "ready", powerBankId });
    return { status: "dispensed", slot, powerBankId, confirmedAt: new Date().toISOString() };
  }

  private freeSlot(): number | null {
    for (let i = 1; i <= 64; i++) if (!this.slots.has(i)) return i;
    return null;
  }

  /** Test hook: physically dock a bank into a slot (marks the slot charging). */
  dock(bankId: string, slot?: number) {
    const s = slot ?? this.freeSlot() ?? 1;
    this.slots.set(s, { status: "charging", powerBankId: bankId });
    return s;
  }
}

export type SimEvent = {
  event_id?: string;
  type: string;
  slot?: number;
  slot_state?: "empty" | "charging" | "ready" | "fault";
  power_bank_serial?: string;
  battery_pct?: number;
  at?: string;
  /** Per-event hardware clock timestamp (ISO-8601) — drives occurred_at ordering. */
  hw_timestamp?: string;
  /** Correlates to device_commands.id / idempotency_key (Phase 2.4 ack contract). */
  command_id?: string;
  /** Rental UUID or public reference the ack/return claims to belong to. */
  rental_ref?: string;
  /** Device-reported ack classification. */
  outcome?: "acknowledged" | "failed" | "rejected" | "detected" | "released";
  /** Short vendor-normalized failure code. */
  error_code?: string;
  /** ALWAYS true for simulator output — forced by KioskSimulator.push. */
  simulated?: boolean;
  payload?: Record<string, unknown>;
};

/** Records the event batches a kiosk would POST to /api/devices/events. */
export class KioskSimulator {
  readonly batches: SimEvent[][] = [];
  private seq = 0;
  private pending: SimEvent[] = [];
  /** Per-instance nonce — event_ids stay unique across simulator instances. */
  private readonly inst = randomBytes(3).toString("hex");

  constructor(private stationId = "SIM-001") {}

  /** Forces simulated:true — a simulator can NEVER emit an unmarked ("physical") event. */
  private push(e: SimEvent) {
    const stored: SimEvent = { ...e, simulated: true };
    this.pending.push(stored);
    return stored;
  }
  flush() { if (this.pending.length) { this.batches.push(this.pending); this.pending = []; } }
  all(): SimEvent[] { return this.batches.flat(); }

  private id() { return `sim-${this.stationId}-${this.inst}-${++this.seq}`; }

  /** Escape hatch for vendor-specific event types — still forces simulated:true. */
  emit(e: SimEvent) { return this.push(e); }

  heartbeat(at?: string, opts: { hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "heartbeat", at,
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
      payload: { station_id: this.stationId },
    });
  }

  /** Slot-level state change (empty/charging/ready/fault). */
  slotState(slot: number, state: "empty" | "charging" | "ready" | "fault", bankSerial?: string, at?: string, opts: { hwTimestamp?: string } = {}) {
    return this.push({
      event_id: this.id(), type: "slot_state", slot, slot_state: state,
      ...(bankSerial ? { power_bank_serial: bankSerial } : {}), at,
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** The verified-return event: a specific bank docked at a slot. */
  dockBank(bankSerial: string, opts: { slot?: number; at?: string; eventId?: string; rentalId?: string; rentalRef?: string; batteryPct?: number; hwTimestamp?: string; commandId?: string } = {}) {
    const e = this.push({
      event_id: opts.eventId ?? this.id(), type: "power_bank_docked",
      ...(opts.slot != null ? { slot: opts.slot } : {}), power_bank_serial: bankSerial,
      ...(opts.batteryPct != null ? { battery_pct: opts.batteryPct } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
      ...(opts.commandId ? { command_id: opts.commandId } : {}),
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      payload: {
        ...(opts.rentalId ? { rental_id: opts.rentalId } : {}),
        ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
        station_id: this.stationId,
      },
    });
    this.flush();
    return e;
  }

  /* ── Phase 2.4 ack/failure events (correlated via command_id / rental_ref) ── */

  /** Positive dispense confirmation — activates a pre-dispense rental. */
  dispenseAck(commandId: string, opts: { slot?: number; bankSerial?: string; rentalRef?: string; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "dispense_acknowledged",
      command_id: commandId, outcome: "acknowledged",
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.bankSerial ? { power_bank_serial: opts.bankSerial } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Physical release of the bank into the pickup bay (dispense confirm variant). */
  bankReleased(commandId: string, opts: { slot?: number; bankSerial?: string; rentalRef?: string; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "bank_released",
      command_id: commandId, outcome: "released",
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.bankSerial ? { power_bank_serial: opts.bankSerial } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Dispense attempt failed on-device (motor jam, no inventory, …). */
  dispenseFailed(commandId: string, errorCode: string, opts: { slot?: number; rentalRef?: string; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "dispense_failed",
      command_id: commandId, outcome: "failed", error_code: errorCode,
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Sensor-level return detection (a bank was seen docked). */
  returnDetected(bankSerial: string, opts: { slot?: number; rentalRef?: string; at?: string; hwTimestamp?: string; eventId?: string; batteryPct?: number } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "return_detected", outcome: "detected",
      power_bank_serial: bankSerial,
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.batteryPct != null ? { battery_pct: opts.batteryPct } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Command-completion ack for a return command — reconciles device_commands. */
  returnAck(commandId: string, opts: { bankSerial?: string; rentalRef?: string; slot?: number; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "return_acknowledged",
      command_id: commandId, outcome: "acknowledged",
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.bankSerial ? { power_bank_serial: opts.bankSerial } : {}),
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Return command rejected on-device. */
  returnRejected(errorCode: string, opts: { commandId?: string; rentalRef?: string; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "return_rejected",
      outcome: "rejected", error_code: errorCode,
      ...(opts.commandId ? { command_id: opts.commandId } : {}),
      ...(opts.rentalRef ? { rental_ref: opts.rentalRef } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Hardware fault report (jam / over-temp / comm loss). */
  hardwareFault(errorCode: string, opts: { slot?: number; at?: string; hwTimestamp?: string; eventId?: string } = {}) {
    return this.push({
      event_id: opts.eventId ?? this.id(), type: "hardware_fault",
      outcome: "failed", error_code: errorCode,
      ...(opts.slot != null ? { slot: opts.slot } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      ...(opts.hwTimestamp ? { hw_timestamp: opts.hwTimestamp } : {}),
    });
  }

  /** Re-queue an already-emitted event verbatim (same event_id) to exercise replay/dedup. */
  replay(e: SimEvent) { return this.push({ ...e }); }

  /** Convenience: run a full dispense → activate → return sequence, returning the dock event. */
  lifecycle(bankSerial: string, opts: { slot?: number; activatedAt?: string; returnedAt?: string } = {}) {
    this.heartbeat(opts.activatedAt);
    this.slotState(opts.slot ?? 1, "ready", bankSerial, opts.activatedAt);
    this.dockBank(bankSerial, { slot: opts.slot ?? 1, at: opts.returnedAt });
    return this.all();
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * SimDeviceSession — in-process equivalent of POST /api/devices/events.
 * Signs the exact raw body (HMAC-SHA256 over `${timestamp}.${body}`), runs
 * verifyDeviceAuth (nonce dedup, rotation overlap, revocation, expiry),
 * enforces the station binding, then calls ingestKioskEvents — the same
 * functions the HTTP route executes. Returns { status, body } like fetch.
 * ══════════════════════════════════════════════════════════════════════ */

export type SimPostOptions = {
  /** Override the dedup nonce (X-Device-Message-Id). Must match [A-Za-z0-9_-]{8,128}. */
  messageId?: string;
  /** Override X-Device-Timestamp (unix seconds or ms). */
  timestamp?: string;
  /** Override X-Device-Signature — used to exercise rejection paths. */
  signature?: string;
  protocolVersion?: number;
  firmwareVersion?: string;
};

export type SimPostResult = {
  status: number;
  body: Record<string, unknown>;
  /** Populated on the success path — per-event lifecycle outcomes. */
  outcomes?: { result: string }[];
};

export class SimDeviceSession {
  private msgSeq = 0;
  /** Per-session nonce — message ids stay unique across sessions/rotations. */
  private readonly inst = randomBytes(3).toString("hex");

  constructor(private opts: {
    db: SupabaseClient;
    /** X-Device-Id — device_uid (or uuid) of the bound system_devices row. */
    deviceUid: string;
    /** station_id posted in the ingest body — must equal device_uid or serial_number. */
    stationId: string;
    /** Raw device credential secret (from redeem/issue/rotation — never persisted here). */
    secret: string;
  }) {}

  private nextMessageId() {
    // [A-Za-z0-9_-]{8,128} — deviceUid is sim-namespaced so already safe.
    return `sim-msg-${this.opts.deviceUid}-${this.inst}-${++this.msgSeq}`.slice(0, 128);
  }

  /**
   * POSTs one ingest batch exactly as the device would: build body → sign →
   * verifyDeviceAuth → station binding → ingestKioskEvents.
   */
  async post(events: SimEvent[], o: SimPostOptions = {}): Promise<SimPostResult> {
    const body = JSON.stringify({
      station_id: this.opts.stationId,
      firmware_version: o.firmwareVersion ?? "sim-fw-0.1",
      events,
    } satisfies IngestBody);
    return this.postRaw(body, o);
  }

  /** Posts a pre-serialized raw body (tamper / malformed-payload tests). */
  async postRaw(rawBody: string, o: SimPostOptions = {}): Promise<SimPostResult> {
    const { db, deviceUid } = this.opts;
    const timestamp = o.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = o.signature ?? signDeviceRequest(this.opts.secret, timestamp, rawBody);
    const messageId = o.messageId ?? this.nextMessageId();

    const v = await verifyDeviceAuth(db, {
      deviceId: deviceUid,
      timestamp,
      signature,
      body: rawBody,
      messageId,
      protocolVersion: o.protocolVersion ?? 2,
    });
    if (!v.ok) {
      return { status: v.status, body: { error: v.error, reason: v.reason } };
    }

    let parsedJson: unknown;
    try { parsedJson = JSON.parse(rawBody); } catch { parsedJson = null; }
    const parsed = ingestBodySchema.safeParse(parsedJson);
    if (!parsed.success) return { status: 422, body: { error: "Invalid payload" } };

    // Station binding — mirrors /api/devices/events: the HMAC device may only
    // post for the station it is registered as (device_uid or serial_number).
    const bound = v.device.device_uid === parsed.data.station_id || v.device.serial_number === parsed.data.station_id;
    if (!bound) return { status: 403, body: { error: "Device is not bound to this station" } };

    const { data: kiosk } = await db.from("kiosks").select("id,state").eq("station_id", parsed.data.station_id).maybeSingle();
    if (!kiosk) return { status: 404, body: { error: "Unknown station" } };

    const result = await ingestKioskEvents(db, kiosk as { id: string; state?: string }, parsed.data);
    return { status: 200, body: { ok: true, accepted: result.accepted, outcomes: result.outcomes }, outcomes: result.outcomes };
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Sim environment provisioning — real lib calls only, sim namespace only.
 * ══════════════════════════════════════════════════════════════════════ */

/** Honest system actor for machine-initiated sim provisioning. */
export const SIM_ACTOR: SystemActor = { id: "kiosk-simulator", role: "system" };

export const isSimNamespace = (v: string | null | undefined) =>
  !!v && (/^sim-/i.test(v) || /^SIM-/i.test(v));

export type SimEnvironment = {
  device: SystemDeviceRow;
  kiosk: { id: string; station_id: string; state?: string };
  deviceUid: string;
  stationId: string;
  /** Raw credential secret — held in memory only, never persisted by the sim. */
  secret: string;
  credentialExpiresAt: string;
  session: SimDeviceSession;
};

const simSuffix = () => randomBytes(4).toString("hex");

/**
 * Creates a complete simulated kiosk stack through the REAL provisioning
 * contract:
 *   1. INSERT system_devices row (status 'registered', adapter_type
 *      'simulator', capabilities.simulated=true, sim- namespace ids).
 *   2. issueProvisionToken → redeemProvisionToken (the /api/devices/provision
 *      contract) → per-device HMAC credential (secret returned once).
 *   3. Status → 'active' via a direct write: the physical install/activation
 *      step is a staff lifecycle flow with no sim equivalent; documented
 *      shortcut, sim rows only.
 *   4. INSERT kiosks row (station_id = SIM-…, state 'online').
 *
 * Returns the env + a ready SimDeviceSession. NEVER touches rows outside the
 * sim- namespace.
 */
export async function createSimEnvironment(
  db: SupabaseClient,
  opts: { suffix?: string; slotCount?: number; model?: string } = {},
): Promise<SimEnvironment> {
  const suffix = opts.suffix ?? simSuffix();
  const deviceUid = `sim-${suffix}`;
  const stationId = `SIM-${suffix.toUpperCase()}`;
  const slotCount = opts.slotCount ?? 8;

  const { data: devRow, error: devErr } = await db.from("system_devices").insert({
    device_uid: deviceUid,
    serial_number: stationId, // station binding: serial_number === station_id
    manufacturer: "Zapnivo Simulator",
    model: opts.model ?? "KioskSim-1",
    gateway: "sim-gateway",
    adapter_type: "simulator",
    capabilities: { simulated: true, harness: "kiosk-simulator", namespace: "sim" },
    slot_count: slotCount,
    firmware_version: "sim-fw-0.1",
    status: "registered",
    created_by: null,
  }).select("*").single();
  if (devErr || !devRow) throw new Error(`sim_device_insert_failed: ${devErr?.message ?? "no row"}`);
  const device = devRow as unknown as SystemDeviceRow;

  // Provisioning contract: staff-side token issue → device-side redeem.
  const tok = await issueProvisionToken(db, device, SIM_ACTOR);
  if (!tok.ok) throw new Error(`sim_provision_token_failed: ${tok.error}`);
  const redeemed = await redeemProvisionToken(db, {
    token: tok.token,
    device_uid: deviceUid,
    serial_number: stationId,
  });
  if (!redeemed.ok) throw new Error(`sim_redeem_failed: ${redeemed.error}`);

  // Sim shortcut: activate the device (real flow = staff lifecycle transitions
  // provisioning → testing → active; meaningless for a simulator row).
  await db.from("system_devices").update({
    status: "active",
    installed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", device.id);

  const { data: kioskRow, error: kioskErr } = await db.from("kiosks").insert({
    station_id: stationId,
    state: "online",
    model: opts.model ?? "KioskSim-1",
    firmware_version: "sim-fw-0.1",
    slot_count: slotCount,
  }).select("id,station_id,state").single();
  if (kioskErr || !kioskRow) throw new Error(`sim_kiosk_insert_failed: ${kioskErr?.message ?? "no row"}`);

  return {
    device,
    kiosk: kioskRow as { id: string; station_id: string; state?: string },
    deviceUid,
    stationId,
    secret: redeemed.secret,
    credentialExpiresAt: redeemed.expiresAt,
    session: new SimDeviceSession({ db, deviceUid, stationId, secret: redeemed.secret }),
  };
}

/**
 * Inserts a sim rental + its power bank, ready for the dispense/return
 * lifecycle. Reference uses the ZR-SIM- namespace so sim rows are always
 * identifiable; pricing_version references the seeded pilot row.
 */
export async function createSimRental(
  db: SupabaseClient,
  env: { kiosk: { id: string } },
  opts: { state?: string; bankSerial?: string; suffix?: string } = {},
): Promise<{ rentalId: string; bankId: string | null; bankSerial: string; reference: string }> {
  const suffix = opts.suffix ?? simSuffix();
  const bankSerial = opts.bankSerial ?? `SIM-BANK-${suffix.toUpperCase()}`;
  const reference = `ZR-SIM-${suffix.toUpperCase()}`;

  const { data: bank } = await db.from("power_banks")
    .upsert({ serial: bankSerial, battery_pct: 100, current_kiosk: env.kiosk.id, retired: false }, { onConflict: "serial" })
    .select("id").single();

  const { data: rental, error } = await db.from("rentals").insert({
    kiosk_id: env.kiosk.id,
    power_bank_id: bank?.id ?? null,
    state: opts.state ?? "payment_authorized",
    pricing_version: "pilot-2026-v1",
    reference,
    bank_count: 1,
    return_disputed: false,
    non_return_fee_status: "none",
  }).select("id").single();
  if (error || !rental) throw new Error(`sim_rental_insert_failed: ${error?.message ?? "no row"}`);
  return { rentalId: rental.id as string, bankId: (bank?.id as string) ?? null, bankSerial, reference };
}
