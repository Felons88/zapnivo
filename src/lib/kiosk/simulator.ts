import type { KioskAdapter, DispenseRequest, DispenseResult, KioskHealth, SlotStatus } from "./adapter";

/**
 * Mock kiosk + lifecycle simulator. Lets the full dispense → activate → return flow run in
 * tests without hardware. The simulator emits the same event shape the ingest route accepts,
 * so tests exercise the real pipeline (ingestKioskEvents / processKioskEvent) end to end.
 */
export class MockKioskAdapter implements KioskAdapter {
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
  payload?: Record<string, unknown>;
};

/** Records the event batches a kiosk would POST to /api/devices/events. */
export class KioskSimulator {
  readonly batches: SimEvent[][] = [];
  private seq = 0;
  private pending: SimEvent[] = [];

  constructor(private stationId = "SIM-001") {}

  private push(e: SimEvent) { this.pending.push(e); return e; }
  flush() { if (this.pending.length) { this.batches.push(this.pending); this.pending = []; } }
  all(): SimEvent[] { return this.batches.flat(); }

  private id() { return `sim-${this.stationId}-${++this.seq}`; }

  heartbeat(at?: string) {
    return this.push({ event_id: this.id(), type: "heartbeat", at, payload: { station_id: this.stationId } });
  }

  /** Slot-level state change (empty/charging/ready/fault). */
  slotState(slot: number, state: "empty" | "charging" | "ready" | "fault", bankSerial?: string, at?: string) {
    return this.push({ event_id: this.id(), type: "slot_state", slot, slot_state: state, ...(bankSerial ? { power_bank_serial: bankSerial } : {}), at });
  }

  /** The verified-return event: a specific bank docked at a slot. */
  dockBank(bankSerial: string, opts: { slot?: number; at?: string; eventId?: string; rentalId?: string; batteryPct?: number } = {}) {
    const e = this.push({
      event_id: opts.eventId ?? this.id(), type: "power_bank_docked",
      ...(opts.slot != null ? { slot: opts.slot } : {}), power_bank_serial: bankSerial,
      ...(opts.batteryPct != null ? { battery_pct: opts.batteryPct } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      payload: { ...(opts.rentalId ? { rental_id: opts.rentalId } : {}), station_id: this.stationId },
    });
    this.flush();
    return e;
  }

  /** Convenience: run a full dispense → activate → return sequence, returning the dock event. */
  lifecycle(bankSerial: string, opts: { slot?: number; activatedAt?: string; returnedAt?: string } = {}) {
    this.heartbeat(opts.activatedAt);
    this.slotState(opts.slot ?? 1, "ready", bankSerial, opts.activatedAt);
    this.dockBank(bankSerial, { slot: opts.slot ?? 1, at: opts.returnedAt });
    return this.all();
  }
}
