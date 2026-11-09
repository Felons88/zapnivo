/**
 * Kiosk control abstraction.
 *
 * NO hardware compatibility is claimed. The manufacturer's interface (MQTT / HTTP / BLE / vendor cloud)
 * is unknown until the physical unit and its documentation have been inspected. A real adapter must
 * implement KioskAdapter; until then NullKioskAdapter fails safe and never reports a dispense.
 */
export type SlotStatus = "empty" | "charging" | "ready" | "fault" | "unknown";

export type KioskHealth = {
  stationId: string;
  online: boolean;
  lastSeenAt: string | null;
  slots: { slot: number; status: SlotStatus; batteryPct?: number }[];
};

export type DispenseRequest = {
  rentalId: string;
  stationId: string;
  /** Idempotency key, unique per paid rental. Retrying with the same key MUST NOT release a second bank. */
  idempotencyKey: string;
};

export type DispenseResult =
  | { status: "dispensed"; slot: number; powerBankId: string; confirmedAt: string }
  | { status: "failed"; reason: "offline" | "no_inventory" | "hardware_fault" | "unsupported" | "duplicate" };

export interface KioskAdapter {
  health(stationId: string): Promise<KioskHealth | null>;
  dispense(req: DispenseRequest): Promise<DispenseResult>;
}

export class NullKioskAdapter implements KioskAdapter {
  async health(_stationId: string): Promise<KioskHealth | null> { return null; }
  async dispense(_req: DispenseRequest): Promise<DispenseResult> { return { status: "failed", reason: "unsupported" }; }
}

/** Wraps any adapter so a repeated idempotency key never triggers a second physical dispense. */
export class IdempotentKioskAdapter implements KioskAdapter {
  private seen = new Map<string, Promise<DispenseResult>>();
  constructor(private inner: KioskAdapter) {}
  health(id: string) { return this.inner.health(id); }
  dispense(req: DispenseRequest) {
    const hit = this.seen.get(req.idempotencyKey);
    if (hit) return hit;
    const p = this.inner.dispense(req);
    this.seen.set(req.idempotencyKey, p);
    return p;
  }
}

/** In production back the idempotency record with the `device_commands` table (unique idempotency_key). */
export const getKioskAdapter = (): KioskAdapter => new IdempotentKioskAdapter(new NullKioskAdapter());
