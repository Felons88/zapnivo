import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestKioskEvents, type IngestBody } from "@/lib/kiosk/ingest";
import { getKioskAdapter } from "@/lib/kiosk/adapter";

/**
 * Phase 2.4 — rental reconciliation via hardware ack ingestion.
 * Exercises the REAL ingest + lifecycle pipeline against the in-memory Supabase
 * stub (same harness as kiosk-lifecycle.test.ts). Asserts: dispense acks activate
 * rentals through the state machine, failures/exceptions never settle or close,
 * command correlation is idempotent, and KIOSK_ADAPTER=none outbound behavior is
 * unchanged (acks are inbound telemetry — still recorded).
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
    power_banks: ["serial"],
    kiosk_slots: ["kiosk_id,slot_number"],
    device_commands: ["idempotency_key"],
  };
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    private onConflict: string | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, o?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = o?.onConflict ?? null; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run(): { data: Row[] | Row | null; error: { code: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          if (this.op === "upsert" && this.onConflict) {
            const cols = this.onConflict.split(",");
            const ex = rows.find((r) => cols.every((c) => eqv(r[c], item[c])));
            if (ex) { Object.assign(ex, item); out.push(ex); continue; }
          }
          for (const spec of UNIQ[this.name] ?? []) {
            const cols = spec.split(",");
            if (cols.some((c) => item[c] == null)) continue;
            if (rows.some((r) => cols.every((c) => eqv(r[c], item[c]))))
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
          const row: Row = { ...item };
          if (row.id == null) row.id = `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
          rows.push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }

    private finish() {
      const { data, error } = this.run();
      return { data, error };
    }
    single() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      return { data: rows[0], error: null };
    }
    maybeSingle() {
      const { data, error } = this.finish();
      if (error) return { data: null, error };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }

  const db = { from: (t: string) => new QB(t) };
  return { db: db as unknown as SupabaseClient, tables };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const KIOSK = { id: "kiosk-1", state: "online" };
const NOW = new Date("2026-02-01T12:00:00.000Z");
const HW = "2026-02-01T11:59:30.000Z";
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const CMD1 = "33333333-3333-4333-8333-333333333333";

const rental = (over: Row = {}): Row => ({
  id: R1, reference: "ZR-TEST", state: "dispense_pending", power_bank_id: "bank-1",
  kiosk_id: "kiosk-1", return_kiosk_id: null, non_return_deadline: null, returned_at: null,
  return_disputed: false, created_at: "2026-02-01T10:00:00.000Z", ...over,
});
const bank = (over: Row = {}): Row => ({ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false, ...over });
const command = (over: Row = {}): Row => ({
  id: CMD1, kiosk_id: "kiosk-1", command: "dispense", idempotency_key: "pay-1",
  status: "sent", payload: { rental_id: R1 }, created_at: "2026-02-01T10:30:00.000Z", resolved_at: null, ...over,
});

function seed(over: Record<string, Row[]> = {}) {
  return {
    kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online", last_seen_at: null }],
    rentals: [rental()],
    power_banks: [bank()],
    device_commands: [command()],
    payments: [{ id: "pay-row-1", rental_id: R1, state: "authorized", amount_authorized_cents: 2000, stripe_payment_intent_id: "pi_test", captured_at: null }],
    kiosk_events: [], device_events: [], kiosk_slots: [], audit_logs: [], rental_exceptions: [],
    ...over,
  };
}

const ackEvent = (over: Record<string, unknown> = {}): IngestBody["events"][number] => ({
  event_id: "ack-1", type: "dispense_acknowledged", command_id: "pay-1",
  power_bank_serial: "SN-001", hw_timestamp: HW, outcome: "acknowledged", ...over,
} as IngestBody["events"][number]);

describe("dispense acknowledgement → rental activation", () => {
  it("dispense_acknowledged activates a dispense_pending rental via command correlation", async () => {
    const { db, tables } = fakeDb(seed());
    const notifyStarted = vi.fn().mockResolvedValue(true);
    const notifyReturned = vi.fn().mockResolvedValue(true);
    const res = await ingestKioskEvents(db, KIOSK, { station_id: "ZP-001", events: [ackEvent()] }, NOW, { notifyStarted, notifyReturned });

    expect(res.outcomes[0]).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0]).toMatchObject({
      state: "active", dispensed_at: HW,
      non_return_deadline: "2026-02-02T12:00:00.000Z", // NOW + 24h (PRICING_V1.nonReturnAfterHours)
    });
    expect(tables.device_commands[0]).toMatchObject({ status: "acknowledged" });
    expect(tables.device_commands[0].resolved_at).toBe(NOW.toISOString());
    expect(notifyStarted).toHaveBeenCalledTimes(1);
    expect(notifyStarted).toHaveBeenCalledWith(R1);
    expect(notifyReturned).not.toHaveBeenCalled();
    expect(tables.audit_logs.some((a) => a.action === "kiosk.dispense_confirmed")).toBe(true);
    // Settlement is NEVER triggered by acks: the payment row is untouched.
    expect(tables.payments[0]).toMatchObject({ state: "authorized", captured_at: null });
  });

  it("bank_released correlates by power_bank_serial alone (no command_id)", async () => {
    const { db, tables } = fakeDb(seed({ device_commands: [] }));
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rel-1", type: "bank_released", power_bank_serial: "SN-001", hw_timestamp: HW }],
    }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.rentals[0].dispensed_at).toBe(HW);
  });

  it("replayed event_id is a duplicate — no double transition, no second notify", async () => {
    const { db, tables } = fakeDb(seed());
    const notifyStarted = vi.fn().mockResolvedValue(true);
    const deps = { notifyStarted };
    const body: IngestBody = { station_id: "ZP-001", events: [ackEvent()] };
    await ingestKioskEvents(db, KIOSK, body, NOW, deps);
    const second = await ingestKioskEvents(db, KIOSK, body, NOW, deps);
    expect(second.outcomes[0]).toEqual({ result: "duplicate" });
    expect(notifyStarted).toHaveBeenCalledTimes(1);
    expect(tables.rental_exceptions).toHaveLength(0);
  });

  it("a second ack for the SAME command (different event_id) is already_recorded", async () => {
    const { db, tables } = fakeDb(seed());
    const notifyStarted = vi.fn().mockResolvedValue(true);
    const deps = { notifyStarted };
    await ingestKioskEvents(db, KIOSK, { station_id: "ZP-001", events: [ackEvent()] }, NOW, deps);
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [ackEvent({ event_id: "ack-2", hw_timestamp: "2026-02-01T11:59:45.000Z" })],
    }, NOW, deps);
    expect(res.outcomes[0]).toEqual({ result: "already_recorded" });
    expect(notifyStarted).toHaveBeenCalledTimes(1);
    // dispensed_at from the FIRST ack is preserved — no overwrite.
    expect(tables.rentals[0].dispensed_at).toBe(HW);
  });

  it("ack on an already-active rental records without re-transitioning", async () => {
    const { db, tables } = fakeDb(seed({ rentals: [rental({ state: "active", dispensed_at: "2026-02-01T10:45:00.000Z" })] }));
    const res = await ingestKioskEvents(db, KIOSK, { station_id: "ZP-001", events: [ackEvent()] }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].dispensed_at).toBe("2026-02-01T10:45:00.000Z"); // untouched
    expect(tables.device_commands[0].status).toBe("acknowledged");
  });
});

describe("ack ambiguity → rental_exceptions, never settlement", () => {
  it("unknown command_id raises an exception and changes nothing", async () => {
    const { db, tables } = fakeDb(seed());
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [ackEvent({ command_id: "does-not-exist", power_bank_serial: undefined })],
    }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "exception_raised", kind: "unknown_command" });
    expect(tables.rental_exceptions).toHaveLength(1);
    expect(tables.rental_exceptions[0]).toMatchObject({ kind: "unknown_command", status: "open", kiosk_id: "kiosk-1" });
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.payments[0].state).toBe("authorized");
  });

  it("rental_ref pointing at a different rental than the command raises rental_ref_mismatch", async () => {
    const { db, tables } = fakeDb(seed({
      rentals: [rental(), rental({ id: R2, reference: "ZR-OTHER", power_bank_id: "bank-2" })],
      power_banks: [bank(), bank({ id: "bank-2", serial: "SN-002" })],
    }));
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [ackEvent({ event_id: "ack-mm", rental_ref: "ZR-OTHER", power_bank_serial: "SN-002" })],
    }, NOW, { notifyStarted: async () => {} });
    // command→R1 vs rental_ref→R2 vs bank→R2: command rental and ref rental disagree.
    expect(res.outcomes[0]).toEqual({ result: "exception_raised", kind: "rental_ref_mismatch" });
    expect(tables.rental_exceptions[0].kind).toBe("rental_ref_mismatch");
    expect(tables.rentals.every((r) => r.state === "dispense_pending")).toBe(true);
  });

  it("bank belonging to a different rental than the acked rental raises bank_mismatch", async () => {
    const { db, tables } = fakeDb(seed({
      rentals: [rental(), rental({ id: R2, reference: "ZR-OTHER", state: "active", power_bank_id: "bank-2" })],
      power_banks: [bank(), bank({ id: "bank-2", serial: "SN-002" })],
    }));
    // rental_ref resolves R1; the reported bank resolves R2 → contradiction.
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [ackEvent({ event_id: "ack-bm", rental_ref: R1, power_bank_serial: "SN-002" })],
    }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "exception_raised", kind: "bank_mismatch" });
    expect(tables.rental_exceptions[0].kind).toBe("bank_mismatch");
    expect(tables.rentals[0].state).toBe("dispense_pending");
  });

  it("a dispense ack against a cancelled rental raises unexpected_rental_state", async () => {
    const { db, tables } = fakeDb(seed({ rentals: [rental({ state: "cancelled" })] }));
    const res = await ingestKioskEvents(db, KIOSK, { station_id: "ZP-001", events: [ackEvent()] }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "exception_raised", kind: "unexpected_rental_state" });
    expect(tables.rental_exceptions[0].kind).toBe("unexpected_rental_state");
    expect(tables.rentals[0].state).toBe("cancelled");
  });
});

describe("failure & fault acks", () => {
  it("dispense_failed marks the command failed and leaves the rental untouched", async () => {
    const { db, tables } = fakeDb(seed());
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "fail-1", type: "dispense_failed", command_id: "pay-1", error_code: "motor_stall", outcome: "failed" }],
    }, NOW, { notifyStarted: async () => {} });
    expect(res.outcomes[0]).toEqual({ result: "ack_recorded" });
    expect(tables.device_commands[0]).toMatchObject({ status: "failed" });
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.audit_logs.some((a) => a.action === "kiosk.ack_failed")).toBe(true);
    expect(tables.payments[0].state).toBe("authorized"); // no settlement, ever
  });

  it("return_rejected is recorded as a failed ack — the rental is NOT returned", async () => {
    const { db, tables } = fakeDb(seed({
      rentals: [rental({ state: "active", dispensed_at: "2026-02-01T10:45:00.000Z" })],
    }));
    const notifyReturned = vi.fn().mockResolvedValue(true);
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rr-1", type: "return_rejected", command_id: "pay-1", power_bank_serial: "SN-001", error_code: "slot_busy", outcome: "rejected" }],
    }, NOW, { notifyReturned });
    expect(res.outcomes[0]).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.rentals[0].returned_at).toBeNull();
    expect(tables.device_commands[0].status).toBe("failed");
    expect(notifyReturned).not.toHaveBeenCalled();
  });

  it("hardware_fault with command correlation is recorded; without correlation is unmatched", async () => {
    const { db, tables } = fakeDb(seed());
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [
        { event_id: "hf-1", type: "hardware_fault", command_id: "pay-1", error_code: "sensor_dead", outcome: "failed" },
        { event_id: "hf-2", type: "hardware_fault", error_code: "unknown" },
      ],
    }, NOW);
    expect(res.outcomes.map((o) => o.result)).toEqual(["ack_recorded", "unmatched"]);
    expect(tables.device_events).toHaveLength(2);
    expect(tables.kiosk_events.map((k) => k.result)).toEqual(["ack_recorded", "unmatched"]);
  });
});

describe("return_detected vs return_acknowledged semantics", () => {
  const activeRental = () => rental({ state: "active", dispensed_at: "2026-02-01T10:45:00.000Z" });

  it("return_detected (sensor) completes the rental through the verified path", async () => {
    const { db, tables } = fakeDb(seed({ rentals: [activeRental()] }));
    const notifyReturned = vi.fn().mockResolvedValue(true);
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rd-1", type: "return_detected", power_bank_serial: "SN-001", at: "2026-02-01T11:58:00.000Z", outcome: "detected" }],
    }, NOW, { notifyReturned });
    expect(res.outcomes[0]).toEqual({ result: "returned", rentalId: R1 });
    expect(tables.rentals[0]).toMatchObject({ state: "returned", return_kiosk_id: "kiosk-1" });
    expect(notifyReturned).toHaveBeenCalledTimes(1);
    // Still no settlement from the ingest path — payment stays authorized.
    expect(tables.payments[0].state).toBe("authorized");
  });

  it("return_acknowledged after return_detected is already_returned and acks the command", async () => {
    const { db, tables } = fakeDb(seed({ rentals: [activeRental()] }));
    const deps = { notifyReturned: vi.fn().mockResolvedValue(true) };
    await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rd-2", type: "return_detected", power_bank_serial: "SN-001", at: "2026-02-01T11:58:00.000Z" }],
    }, NOW, deps);
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "ra-1", type: "return_acknowledged", command_id: "pay-1", power_bank_serial: "SN-001", at: "2026-02-01T11:59:00.000Z", outcome: "acknowledged" }],
    }, NOW, deps);
    expect(res.outcomes[0]).toEqual({ result: "already_returned" });
    expect(tables.rentals[0].state).toBe("returned");
    expect(tables.device_commands[0].status).toBe("acknowledged"); // command completion recorded
    expect(deps.notifyReturned).toHaveBeenCalledTimes(1); // no double notify
  });

  it("return_detected events are still out-of-order protected", async () => {
    const { db } = fakeDb(seed({ rentals: [activeRental(), rental({ id: R2, power_bank_id: "bank-2", state: "active" })], power_banks: [bank(), bank({ id: "bank-2", serial: "SN-002" })] }));
    const deps = { notifyReturned: async () => {} };
    await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rd-new", type: "return_detected", power_bank_serial: "SN-001", at: "2026-02-01T11:59:00.000Z" }],
    }, NOW, deps);
    const res = await ingestKioskEvents(db, KIOSK, {
      station_id: "ZP-001",
      events: [{ event_id: "rd-old", type: "return_detected", power_bank_serial: "SN-002", at: "2026-02-01T11:00:00.000Z" }],
    }, NOW, deps);
    expect(res.outcomes[0]).toEqual({ result: "out_of_order" });
  });
});

describe("KIOSK_ADAPTER=none behavior", () => {
  it("NullKioskAdapter still refuses outbound dispense; inbound acks still record", async () => {
    const adapter = getKioskAdapter();
    expect(adapter.name).toBe("none"); // IdempotentKioskAdapter(NullKioskAdapter)
    const res = await adapter.dispense({ rentalId: R1, stationId: "ZP-001", idempotencyKey: "pay-1" });
    expect(res).toEqual({ status: "failed", reason: "unsupported" });

    // …but authenticated inbound ack telemetry is still ingested and recorded.
    const { db, tables } = fakeDb(seed());
    const out = await ingestKioskEvents(db, KIOSK, { station_id: "ZP-001", events: [ackEvent()] }, NOW, { notifyStarted: async () => {} });
    expect(out.outcomes[0].result).toBe("ack_recorded");
    expect(tables.device_events).toHaveLength(1);
  });
});
