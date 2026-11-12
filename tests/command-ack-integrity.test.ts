import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processKioskEvent, type KioskEventInput } from "@/lib/kiosk/lifecycle";
import {
  queueCommand, transitionCommand, markCommandSent, requeueCommand, sweepStaleCommands,
  canTransitionCommand, PHYSICAL_COMMANDS, DEFAULT_COMMAND_TTL_SECONDS,
} from "@/lib/kiosk/commands";

/**
 * Phase 2.5 — command/ack integrity.
 * Covers the device_commands state machine (commands.ts), ack gating in
 * lifecycle.handleDeviceAck (cross-device, stale, conflicting, unexpected-type),
 * the unknown-outcome sweep, and guarded requeue. Same in-memory Supabase stub
 * harness as rental-reconciliation.test.ts / kiosk-lifecycle.test.ts.
 * Asserts NO settlement path is ever touched by acks.
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
const KIOSK2 = { id: "kiosk-2", state: "online" };
const NOW = new Date("2026-02-01T12:00:00.000Z");
const HW = "2026-02-01T11:59:30.000Z";
const R1 = "11111111-1111-4111-8111-111111111111";
const CMD1 = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";

const rental = (over: Row = {}): Row => ({
  id: R1, reference: "ZR-TEST", state: "dispense_pending", power_bank_id: "bank-1",
  kiosk_id: "kiosk-1", return_kiosk_id: null, non_return_deadline: null, returned_at: null,
  return_disputed: false, created_at: "2026-02-01T10:00:00.000Z", ...over,
});
const bank = (over: Row = {}): Row => ({ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false, ...over });
const command = (over: Row = {}): Row => ({
  id: CMD1, kiosk_id: "kiosk-1", command: "dispense", idempotency_key: "pay-1",
  status: "sent", payload: { rental_id: R1 },
  created_at: "2026-02-01T10:30:00.000Z", resolved_at: null,
  expires_at: null, expected_response_types: null, resolved_outcome: null,
  attempt_count: 0, last_transition_at: "2026-02-01T10:30:00.000Z", issued_by: null,
  ...over,
});
const payment = (): Row => ({ id: "pay-row-1", rental_id: R1, state: "authorized", amount_authorized_cents: 2000, stripe_payment_intent_id: "pi_test", captured_at: null });

function seed(over: Record<string, Row[]> = {}) {
  return {
    kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online" }, { id: "kiosk-2", station_id: "ZP-002", state: "online" }],
    rentals: [rental()],
    power_banks: [bank()],
    device_commands: [command()],
    payments: [payment()],
    kiosk_events: [], device_events: [], kiosk_slots: [], audit_logs: [], rental_exceptions: [],
    ...over,
  };
}

const ackEv = (over: Partial<KioskEventInput> = {}): KioskEventInput => ({
  eventId: "ack-1", type: "dispense_acknowledged", commandId: "pay-1",
  powerBankId: "bank-1", hwTimestamp: HW, occurredAt: HW, ...over,
});

const notify = { notifyStarted: async () => {}, notifyReturned: async () => {} };

/* ── queueCommand ──────────────────────────────────────────────────────── */

describe("queueCommand — issuance hardening", () => {
  it("stores expected_response_types, expires_at (ttl), issued_by and attempt_count", async () => {
    const { db, tables } = fakeDb({ device_commands: [] });
    const t0 = new Date("2026-02-01T12:00:00.000Z");
    const res = await queueCommand(db, {
      kioskId: "kiosk-1", command: "dispense", issuedBy: STAFF,
      payload: { rental_id: R1 }, key: "disp-1",
      expectedResponseTypes: ["dispense_acknowledged", "dispense_failed"],
      ttlSeconds: 300, now: t0,
    });
    expect(res.duplicate).toBe(false);
    expect(tables.device_commands).toHaveLength(1);
    expect(tables.device_commands[0]).toMatchObject({
      kiosk_id: "kiosk-1", command: "dispense", idempotency_key: "disp-1",
      status: "queued", issued_by: STAFF, attempt_count: 0,
      expected_response_types: ["dispense_acknowledged", "dispense_failed"],
      expires_at: "2026-02-01T12:05:00.000Z",
    });
  });

  it("duplicate idempotency_key is a safe no-op", async () => {
    const { db, tables } = fakeDb({ device_commands: [] });
    const c = { kioskId: "kiosk-1", command: "reboot" as const, issuedBy: null, key: "rb-1" };
    const first = await queueCommand(db, c);
    const second = await queueCommand(db, c);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true });
    expect(tables.device_commands).toHaveLength(1);
  });

  it("rejects a non-uuid issuedBy (stores null) and defaults ttl", async () => {
    const { db, tables } = fakeDb({ device_commands: [] });
    await queueCommand(db, { kioskId: "kiosk-1", command: "enable", issuedBy: "staff-1", key: "en-1" });
    expect(tables.device_commands[0].issued_by).toBeNull();
    expect(tables.device_commands[0].expires_at).toBeTruthy();
    expect(DEFAULT_COMMAND_TTL_SECONDS).toBe(600);
  });
});

/* ── transitionCommand / state machine ─────────────────────────────────── */

describe("command state machine", () => {
  it("allows queued → sent → awaiting_ack → acknowledged with resolved_outcome", async () => {
    const { db, tables } = fakeDb({ device_commands: [command({ status: "queued", idempotency_key: "q-1" })] });
    expect(await markCommandSent(db, CMD1, NOW)).toEqual({ ok: true, from: "queued" });
    expect(await transitionCommand(db, { id: CMD1 }, "awaiting_ack", { now: NOW })).toEqual({ ok: true, from: "sent" });
    expect(await transitionCommand(db, { id: CMD1 }, "acknowledged", { resolvedOutcome: "acknowledged", now: NOW })).toEqual({ ok: true, from: "awaiting_ack" });
    expect(tables.device_commands[0]).toMatchObject({
      status: "acknowledged", resolved_outcome: "acknowledged",
      resolved_at: NOW.toISOString(), last_transition_at: NOW.toISOString(),
    });
  });

  it("refuses illegal transitions (queued → acknowledged, acknowledged → sent)", async () => {
    const { db } = fakeDb({ device_commands: [command({ status: "queued", idempotency_key: "q-2" })] });
    expect(await transitionCommand(db, { id: CMD1 }, "acknowledged")).toEqual({ ok: false, reason: "illegal_transition", from: "queued" });
    await transitionCommand(db, { id: CMD1 }, "sent");
    await transitionCommand(db, { id: CMD1 }, "acknowledged", { resolvedOutcome: "acknowledged" });
    expect(await transitionCommand(db, { id: CMD1 }, "sent")).toEqual({ ok: false, reason: "illegal_transition", from: "acknowledged" });
    expect(await transitionCommand(db, { id: "missing" }, "sent")).toEqual({ ok: false, reason: "not_found" });
  });

  it("canTransitionCommand documents the edges", () => {
    expect(canTransitionCommand("queued", "sent")).toBe(true);
    expect(canTransitionCommand("sent", "unknown_outcome")).toBe(true);
    expect(canTransitionCommand("unknown_outcome", "sent")).toBe(false);
    expect(canTransitionCommand("failed", "queued")).toBe(true); // requeue edge
    expect(canTransitionCommand("acknowledged", "acknowledged")).toBe(true); // idempotent
  });
});

/* ── Ack gating in handleDeviceAck ─────────────────────────────────────── */

describe("ack integrity — cross-device", () => {
  it("an ack for a command owned by ANOTHER kiosk raises cross_device_ack and changes nothing", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ kiosk_id: "kiosk-2", idempotency_key: "foreign-1" })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({ commandId: "foreign-1", eventId: "xa-1" }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "cross_device_ack" });
    expect(tables.rental_exceptions[0]).toMatchObject({ kind: "cross_device_ack", status: "open", kiosk_id: "kiosk-1" });
    expect(tables.device_commands[0]).toMatchObject({ kiosk_id: "kiosk-2", status: "sent" }); // untouched
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.payments[0].state).toBe("authorized"); // no settlement
  });
});

describe("ack integrity — stale acks never transition", () => {
  it("ack against an unknown_outcome command → stale_ack; closed rental stays closed", async () => {
    const { db, tables } = fakeDb(seed({
      rentals: [rental({ state: "returned", returned_at: "2026-02-01T11:00:00.000Z" })],
      device_commands: [command({
        status: "unknown_outcome", resolved_at: "2026-02-01T11:30:00.000Z",
        resolved_outcome: "unknown_outcome",
      })],
    }));
    const notifyStarted = vi.fn();
    const out = await processKioskEvent(db, KIOSK, ackEv({ eventId: "st-1" }), NOW, { notifyStarted });
    expect(out).toEqual({ result: "exception_raised", kind: "stale_ack" });
    expect(tables.rental_exceptions[0].kind).toBe("stale_ack");
    expect(tables.rentals[0].state).toBe("returned"); // NOT restarted
    expect(tables.device_commands[0].status).toBe("unknown_outcome"); // not re-opened
    expect(notifyStarted).not.toHaveBeenCalled();
  });

  it("ack against a timeout command → stale_ack", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ status: "timeout", resolved_at: "2026-02-01T11:30:00.000Z", resolved_outcome: "timeout" })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({ eventId: "st-2" }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "stale_ack" });
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.device_commands[0].status).toBe("timeout");
  });

  it("ack event time beyond expires_at + grace → stale_ack; command stays open-but-flagged", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ expires_at: "2026-02-01T11:59:00.000Z" })],
    }));
    // occurredAt 12:00 is > expires_at(11:59) + 60s grace? 11:59+60s = 12:00:00 — boundary.
    // Use a clearly-late ack instead:
    const out = await processKioskEvent(db, KIOSK, ackEv({
      eventId: "st-3", occurredAt: "2026-02-01T12:05:00.000Z", hwTimestamp: "2026-02-01T12:05:00.000Z",
    }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "stale_ack" });
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.device_commands[0].status).toBe("sent"); // sweep, not the ack, resolves it
    expect(tables.rental_exceptions[0].kind).toBe("stale_ack");
  });

  it("a TIMELY ack on an expiring command still resolves normally", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ expires_at: "2026-02-01T12:30:00.000Z" })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({ eventId: "ok-1" }), NOW, notify);
    expect(out).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.device_commands[0].status).toBe("acknowledged");
  });

  it("an ack far older than the command's resolved_at → stale_ack (not already_recorded)", async () => {
    const { db } = fakeDb(seed({
      device_commands: [command({
        status: "acknowledged", resolved_outcome: "acknowledged",
        resolved_at: "2026-02-01T12:00:00.000Z",
      })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({
      eventId: "anc-1", occurredAt: "2026-02-01T10:00:00.000Z", hwTimestamp: "2026-02-01T10:00:00.000Z",
    }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "stale_ack" });
  });
});

describe("ack integrity — conflicting & duplicate acks", () => {
  it("positive ack after a recorded failure → conflicting_ack exception", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ status: "failed", resolved_outcome: "failed", resolved_at: "2026-02-01T11:50:00.000Z" })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({ eventId: "cf-1" }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "conflicting_ack" });
    expect(tables.rental_exceptions[0].kind).toBe("conflicting_ack");
    expect(tables.device_commands[0].status).toBe("failed"); // outcome not overwritten
    expect(tables.rentals[0].state).toBe("dispense_pending");
  });

  it("a second ack with the SAME outcome stays already_recorded (idempotent)", async () => {
    const { db, tables } = fakeDb(seed());
    const deps = { notifyStarted: vi.fn().mockResolvedValue(true) };
    await processKioskEvent(db, KIOSK, ackEv({ eventId: "dup-1" }), NOW, deps);
    const second = await processKioskEvent(db, KIOSK, ackEv({
      eventId: "dup-2", occurredAt: "2026-02-01T11:59:45.000Z", hwTimestamp: "2026-02-01T11:59:45.000Z",
    }), NOW, deps);
    expect(second).toEqual({ result: "already_recorded" });
    expect(tables.rentals[0].dispensed_at).toBe(HW); // first ack's timestamp preserved
    expect(tables.rental_exceptions).toHaveLength(0);
    expect(deps.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("failure ack after recorded success → conflicting_ack", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ status: "acknowledged", resolved_outcome: "acknowledged", resolved_at: "2026-02-01T11:50:00.000Z" })],
    }));
    const out = await processKioskEvent(db, KIOSK, {
      eventId: "cf-2", type: "dispense_failed", commandId: "pay-1",
      errorCode: "motor_stall", occurredAt: HW, hwTimestamp: HW,
    }, NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "conflicting_ack" });
    expect(tables.device_commands[0].status).toBe("acknowledged");
  });
});

describe("ack integrity — expected_response_types", () => {
  it("an ack type outside expected_response_types → unexpected_ack_type; no transition", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ expected_response_types: ["dispense_acknowledged"] })],
    }));
    // bank_released is a positive confirm type but NOT in the expected list.
    const out = await processKioskEvent(db, KIOSK, ackEv({
      eventId: "et-1", type: "bank_released", occurredAt: HW, hwTimestamp: HW,
    }), NOW, notify);
    expect(out).toEqual({ result: "exception_raised", kind: "unexpected_ack_type" });
    expect(tables.rental_exceptions[0].kind).toBe("unexpected_ack_type");
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.device_commands[0].status).toBe("sent");
  });

  it("the expected type resolves the command normally", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ expected_response_types: ["dispense_acknowledged"] })],
    }));
    const out = await processKioskEvent(db, KIOSK, ackEv({ eventId: "et-2" }), NOW, notify);
    expect(out).toEqual({ result: "ack_recorded" });
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.device_commands[0].status).toBe("acknowledged");
  });
});

/* ── sweepStaleCommands ────────────────────────────────────────────────── */

describe("sweepStaleCommands — unknown_outcome, never failed", () => {
  it("past-expiry open command → unknown_outcome + command_timeout exception (rental-linked) + audit", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({
        status: "sent", expires_at: "2026-02-01T11:00:00.000Z", // 1h before NOW
      })],
    }));
    const res = await sweepStaleCommands(db, NOW);
    expect(res).toMatchObject({ unknownOutcome: 1, expired: 0, exceptions: 1 });
    expect(tables.device_commands[0].status).toBe("unknown_outcome"); // NOT 'failed'
    expect(tables.device_commands[0].resolved_at).toBe(NOW.toISOString());
    expect(tables.rental_exceptions[0]).toMatchObject({
      kind: "command_timeout", status: "open", rental_id: R1, kiosk_id: "kiosk-1",
    });
    expect(tables.audit_logs.some((a) => a.action === "kiosk.command_unknown_outcome")).toBe(true);
  });

  it("does not touch unexpired or already-resolved commands", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [
        command({ id: "c-open", idempotency_key: "k-open", expires_at: "2026-02-01T13:00:00.000Z" }),
        command({ id: "c-done", idempotency_key: "k-done", status: "acknowledged", resolved_at: "2026-02-01T10:00:00.000Z", expires_at: "2026-02-01T10:30:00.000Z" }),
      ],
    }));
    const res = await sweepStaleCommands(db, NOW);
    expect(res.unknownOutcome).toBe(0);
    expect(tables.device_commands[0].status).toBe("sent");
    expect(tables.device_commands[1].status).toBe("acknowledged");
    expect(tables.rental_exceptions).toHaveLength(0);
  });

  it("a swept command with no rental link gets audit but NO exception row", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ command: "reboot", payload: null, expires_at: "2026-02-01T11:00:00.000Z" })],
    }));
    const res = await sweepStaleCommands(db, NOW);
    expect(res).toMatchObject({ unknownOutcome: 1, exceptions: 0 });
    expect(tables.rental_exceptions).toHaveLength(0);
    expect(tables.audit_logs.some((a) => a.action === "kiosk.command_unknown_outcome")).toBe(true);
  });

  it("legacy rows without expires_at: queued>24h → expired, sent>24h → unknown_outcome", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [
        command({ id: "c-q", idempotency_key: "k-q", status: "queued", expires_at: null, created_at: "2026-01-30T00:00:00.000Z" }),
        command({ id: "c-s", idempotency_key: "k-s", status: "sent", expires_at: null, created_at: "2026-01-30T00:00:00.000Z" }),
        command({ id: "c-fresh", idempotency_key: "k-fresh", status: "queued", expires_at: null, created_at: "2026-02-01T10:00:00.000Z" }),
      ],
    }));
    const res = await sweepStaleCommands(db, NOW);
    expect(res).toMatchObject({ unknownOutcome: 1, expired: 1 });
    expect(tables.device_commands[0].status).toBe("expired");
    expect(tables.device_commands[1].status).toBe("unknown_outcome");
    expect(tables.device_commands[2].status).toBe("queued");
  });
});

/* ── requeueCommand — safe retry ───────────────────────────────────────── */

describe("requeueCommand — guarded retry", () => {
  it("requeues a failed non-physical command with a NEW idempotency key and attempt_count", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ command: "reboot", status: "failed", resolved_outcome: "failed", resolved_at: "2026-02-01T11:50:00.000Z", attempt_count: 0 })],
    }));
    const res = await requeueCommand(db, CMD1, { issuedBy: STAFF, now: NOW });
    expect(res).toEqual({ ok: true, id: CMD1, attempt: 1 });
    expect(tables.device_commands[0]).toMatchObject({
      status: "queued", attempt_count: 1, resolved_at: null, resolved_outcome: null,
      issued_by: STAFF, idempotency_key: "pay-1:r1",
    });
    expect(tables.device_commands[0].expires_at).toBe("2026-02-01T12:10:00.000Z"); // NOW + 600s default ttl
    expect(tables.audit_logs.some((a) => a.action === "kiosk.command_requeued")).toBe(true);
  });

  it("refuses physical commands unless allowPhysical is set", () => {
    expect(PHYSICAL_COMMANDS.has("dispense")).toBe(true);
    expect(PHYSICAL_COMMANDS.has("return_slot")).toBe(true);
    expect(PHYSICAL_COMMANDS.has("reboot")).toBe(false);
  });

  it("physical dispense command → physical_requires_review without allowPhysical", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ status: "failed", resolved_outcome: "failed", resolved_at: "2026-02-01T11:50:00.000Z" })],
    }));
    const res = await requeueCommand(db, CMD1, { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: "physical_requires_review", command: "dispense" });
    expect(tables.device_commands[0].status).toBe("failed"); // untouched
  });

  it("physical dispense WITH allowPhysical requeues (staff decision, attempt 2)", async () => {
    const { db, tables } = fakeDb(seed({
      device_commands: [command({ status: "timeout", resolved_outcome: "timeout", resolved_at: "2026-02-01T11:50:00.000Z", attempt_count: 1 })],
    }));
    const res = await requeueCommand(db, CMD1, { allowPhysical: true, now: NOW });
    expect(res).toEqual({ ok: true, id: CMD1, attempt: 2 });
    expect(tables.device_commands[0]).toMatchObject({ status: "queued", attempt_count: 2, idempotency_key: "pay-1:r2" });
  });

  it("unknown_outcome / requires_investigation must be resolved by a human first", async () => {
    for (const status of ["unknown_outcome", "requires_investigation"]) {
      const { db, tables } = fakeDb(seed({
        device_commands: [command({ command: "reboot", status, resolved_at: "2026-02-01T11:50:00.000Z" })],
      }));
      const res = await requeueCommand(db, CMD1, { now: NOW });
      expect(res).toMatchObject({ ok: false, reason: "requires_investigation", from: status });
      expect(tables.device_commands[0].status).toBe(status);
    }
  });

  it("open or terminal-success commands cannot be requeued", async () => {
    for (const status of ["queued", "sent", "awaiting_ack", "acknowledged", "confirmed", "cancelled"]) {
      const { db } = fakeDb(seed({
        device_commands: [command({ command: "reboot", status })],
      }));
      const res = await requeueCommand(db, CMD1, { now: NOW });
      // cancelled IS requeueable per REQUEUEABLE_STATES — split expectations:
      if (status === "cancelled") expect(res.ok).toBe(true);
      else expect(res).toMatchObject({ ok: false });
    }
  });

  it("unknown command id → not_found", async () => {
    const { db } = fakeDb(seed({ device_commands: [] }));
    expect(await requeueCommand(db, "nope", { now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });
});
