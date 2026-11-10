import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { heartbeatStale, HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { ingestKioskEvents, type IngestBody } from "@/lib/kiosk/ingest";
import { processKioskEvent } from "@/lib/kiosk/lifecycle";
import { MockKioskAdapter, KioskSimulator } from "@/lib/kiosk/simulator";

type Row = Record<string, unknown>;

/** Minimal in-memory SupabaseClient covering the query shapes the kiosk pipeline uses. */
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
    power_banks: ["serial"],
    kiosk_slots: ["kiosk_id,slot_number"],
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

const KIOSK = { id: "kiosk-1", station_id: "ZP-001", state: "online" };
const T0 = "2026-01-01T00:00:00.000Z";
const rental = (over: Row = {}): Row => ({
  id: "r1", reference: "ZR-TEST", state: "active", power_bank_id: "bank-1", kiosk_id: "kiosk-1",
  return_kiosk_id: null, non_return_deadline: null, returned_at: null, return_disputed: false,
  non_return_fee_status: "none", created_at: T0, ...over,
});
const bank = (over: Row = {}): Row => ({ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false, ...over });
const dock = (over: Partial<Parameters<typeof processKioskEvent>[2]> = {}) => ({
  eventId: "ev-1", type: "power_bank_docked", powerBankId: "bank-1",
  deviceAt: "2026-01-01T02:00:00.000Z", occurredAt: "2026-01-01T02:00:00.000Z", ...over,
});
const NOW = new Date("2026-01-01T02:05:00.000Z");

describe("processKioskEvent — verified returns", () => {
  it("completes an active rental, preserves the kiosk dock time, and notifies", async () => {
    const { db, tables } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const notify = vi.fn().mockResolvedValue(true);
    const out = await processKioskEvent(db, KIOSK, dock(), NOW, { notifyReturned: notify });
    expect(out).toEqual({ result: "returned", rentalId: "r1" });
    expect(tables.rentals[0]).toMatchObject({
      state: "returned", returned_at: "2026-01-01T02:00:00.000Z", return_kiosk_id: "kiosk-1",
    });
    expect(notify).toHaveBeenCalledWith("r1");
    expect(tables.kiosk_events[0]).toMatchObject({ event_id: "ev-1", result: "returned" });
    expect(tables.audit_logs.some((a) => a.action === "kiosk.return_processed")).toBe(true);
  });

  it("falls back to server UTC when the event carries no device time", async () => {
    const { db, tables } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    await processKioskEvent(db, KIOSK, dock({ deviceAt: null, occurredAt: NOW.toISOString(), eventId: "ev-2" }), NOW, { notifyReturned: async () => {} });
    expect(tables.rentals[0].returned_at).toBe(NOW.toISOString());
  });

  it("dedupes replayed event ids — second delivery is a no-op", async () => {
    const { db, tables } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const deps = { notifyReturned: vi.fn() };
    const first = await processKioskEvent(db, KIOSK, dock(), NOW, deps);
    const second = await processKioskEvent(db, KIOSK, dock(), NOW, deps);
    expect(first.result).toBe("returned");
    expect(second).toEqual({ result: "duplicate" });
    expect(deps.notifyReturned).toHaveBeenCalledTimes(1);
    expect(tables.kiosk_events).toHaveLength(1);
  });

  it("rejects a second, different event for an already-returned bank", async () => {
    const { db } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const deps = { notifyReturned: async () => {} };
    await processKioskEvent(db, KIOSK, dock(), NOW, deps);
    const out = await processKioskEvent(db, KIOSK, dock({ eventId: "ev-2", occurredAt: "2026-01-01T02:01:00.000Z", deviceAt: "2026-01-01T02:01:00.000Z" }), NOW, deps);
    expect(out).toEqual({ result: "already_returned" });
  });

  it("rejects out-of-order events (older occurred_at after a newer processed one)", async () => {
    const { db } = fakeDb({ rentals: [rental({ id: "r-old", power_bank_id: "bank-2" }), rental()], power_banks: [bank(), bank({ id: "bank-2", serial: "SN-002" })] });
    const deps = { notifyReturned: async () => {} };
    await processKioskEvent(db, KIOSK, dock({ eventId: "new", powerBankId: "bank-1", occurredAt: "2026-01-01T03:00:00.000Z", deviceAt: "2026-01-01T03:00:00.000Z" }), new Date("2026-01-01T03:05:00Z"), deps);
    const out = await processKioskEvent(db, KIOSK, dock({ eventId: "old", powerBankId: "bank-2", occurredAt: "2026-01-01T02:00:00.000Z", deviceAt: "2026-01-01T02:00:00.000Z" }), NOW, deps);
    expect(out).toEqual({ result: "out_of_order" });
  });

  it("flags post-deadline arrivals for admin review instead of any fee path", async () => {
    const { db, tables } = fakeDb({
      rentals: [rental({ state: "overdue", non_return_deadline: "2026-01-01T01:00:00.000Z", non_return_fee_status: "none" })],
      power_banks: [bank()],
    });
    const notify = vi.fn().mockResolvedValue(true);
    const out = await processKioskEvent(db, KIOSK, dock(), NOW, { notifyReturned: notify });
    expect(out).toEqual({ result: "return_disputed", rentalId: "r1" });
    expect(tables.rentals[0]).toMatchObject({ state: "returned", return_disputed: true, non_return_fee_status: "none" });
    expect(tables.audit_logs.some((a) => a.action === "kiosk.return_disputed")).toBe(true);
  });

  it("rejects a dock naming a bank that doesn't match the rental's assigned bank", async () => {
    const { db, tables } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const out = await processKioskEvent(db, KIOSK, dock({ powerBankId: "bank-OTHER" }), NOW, { notifyReturned: async () => {} });
    expect(out).toEqual({ result: "rejected:wrong_bank" });
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.rentals[0].returned_at).toBeNull();
    expect(tables.audit_logs.some((a) => a.action === "kiosk.event_rejected")).toBe(true);
  });

  it("rejects a rental_id hint whose bank doesn't match", async () => {
    const { db } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const out = await processKioskEvent(db, KIOSK, dock({ powerBankId: "bank-OTHER", payload: { rental_id: "r1" } }), NOW, { notifyReturned: async () => {} });
    expect(out).toEqual({ result: "rejected:wrong_bank" });
  });

  it("rejects an unmatched bank when no rental exists anywhere", async () => {
    const { db } = fakeDb({ rentals: [], power_banks: [bank()] });
    const out = await processKioskEvent(db, KIOSK, dock(), NOW, { notifyReturned: async () => {} });
    expect(out).toEqual({ result: "rejected:unmatched_bank" });
  });

  it("returns a bank at a DIFFERENT kiosk than pickup (return-anywhere)", async () => {
    const { db, tables } = fakeDb({ rentals: [rental()], power_banks: [bank()] });
    const other = { id: "kiosk-2", station_id: "ZP-002", state: "online" };
    await processKioskEvent(db, other, dock({ eventId: "ev-x" }), NOW, { notifyReturned: async () => {} });
    expect(tables.rentals[0]).toMatchObject({ state: "returned", return_kiosk_id: "kiosk-2" });
  });

  it("ignores non-return event types but still dedupes them", async () => {
    const { db } = fakeDb({ rentals: [], power_banks: [] });
    const ev = { eventId: "hb-1", type: "heartbeat", occurredAt: NOW.toISOString() };
    expect(await processKioskEvent(db, KIOSK, ev, NOW)).toEqual({ result: "heartbeat" });
    expect(await processKioskEvent(db, KIOSK, ev, NOW)).toEqual({ result: "duplicate" });
  });
});

describe("ingestKioskEvents + simulator — full lifecycle", () => {
  const body = (events: ReturnType<KioskSimulator["all"]>): IngestBody => ({ station_id: "ZP-001", events });

  it("runs heartbeat → slot ready → dock through the real ingest pipeline", async () => {
    const { db, tables } = fakeDb({
      kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online", last_seen_at: null }],
      rentals: [rental()],
      power_banks: [bank()],
      kiosk_slots: [], device_events: [], kiosk_events: [], audit_logs: [],
    });
    const adapter = new MockKioskAdapter("ZP-001");
    adapter.banks.push("SN-001");
    const dispense = await adapter.dispense({ rentalId: "r1", stationId: "ZP-001", idempotencyKey: "pay-1" });
    expect(dispense.status).toBe("dispensed");

    const sim = new KioskSimulator("ZP-001");
    sim.heartbeat(T0);
    sim.slotState(1, "ready", "SN-001", "2026-01-01T01:00:00.000Z");
    sim.dockBank("SN-001", { slot: 1, at: "2026-01-01T02:00:00.000Z" });
    const notify = vi.fn().mockResolvedValue(true);
    const result = await ingestKioskEvents(db, KIOSK, body(sim.all()), NOW, { notifyReturned: notify });

    expect(result.accepted).toBe(3);
    expect(result.outcomes.map((o) => o.result)).toEqual(["heartbeat", "ignored", "returned"]);
    expect(tables.rentals[0]).toMatchObject({ state: "returned", returned_at: "2026-01-01T02:00:00.000Z" });
    expect(tables.kiosks[0].last_seen_at).toBe(NOW.toISOString());
    expect(tables.kiosk_slots[0]).toMatchObject({ slot_number: 1, state: "ready", power_bank_id: "bank-1" });
    expect(tables.device_events).toHaveLength(3);
  });

  it("replaying the same ingest batch changes nothing", async () => {
    const { db, tables } = fakeDb({
      kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online" }],
      rentals: [rental()], power_banks: [bank()], kiosk_slots: [], device_events: [], kiosk_events: [], audit_logs: [],
    });
    const sim = new KioskSimulator("ZP-001");
    const events = sim.lifecycle("SN-001", { returnedAt: "2026-01-01T02:00:00.000Z" });
    const deps = { notifyReturned: vi.fn().mockResolvedValue(true) };
    await ingestKioskEvents(db, KIOSK, body(events), NOW, deps);
    const second = await ingestKioskEvents(db, KIOSK, body(events), NOW, deps);
    expect(second.outcomes.map((o) => o.result)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(deps.notifyReturned).toHaveBeenCalledTimes(1);
    expect(tables.rentals[0].state).toBe("returned");
  });
});

describe("MockKioskAdapter", () => {
  it("dispenses FIFO banks into free slots and reports health", async () => {
    const a = new MockKioskAdapter("ZP-001");
    a.banks.push("B1", "B2");
    const r1 = await a.dispense({ rentalId: "r1", stationId: "ZP-001", idempotencyKey: "k1" });
    const r2 = await a.dispense({ rentalId: "r2", stationId: "ZP-001", idempotencyKey: "k2" });
    expect(r1).toMatchObject({ status: "dispensed", powerBankId: "B1", slot: 1 });
    expect(r2).toMatchObject({ status: "dispensed", powerBankId: "B2", slot: 2 });
    expect((await a.dispense({ rentalId: "r3", stationId: "ZP-001", idempotencyKey: "k3" })).status).toBe("failed");
    const h = await a.health("ZP-001");
    expect(h?.slots).toHaveLength(2);
    expect(h?.slots[0]).toMatchObject({ slot: 1, status: "ready" });
  });

  it("fails safe when offline or empty", async () => {
    const a = new MockKioskAdapter("ZP-001");
    a.online = false;
    expect(await a.dispense({ rentalId: "r", stationId: "s", idempotencyKey: "k" })).toMatchObject({ status: "failed", reason: "offline" });
    a.online = true;
    expect(await a.dispense({ rentalId: "r", stationId: "s", idempotencyKey: "k2" })).toMatchObject({ status: "failed", reason: "no_inventory" });
  });
});

describe("heartbeat staleness", () => {
  it("flags missing and old heartbeats, passes fresh ones", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(HEARTBEAT_STALE_MIN).toBe(15);
    expect(heartbeatStale(null, now)).toBe(true);
    expect(heartbeatStale("2026-01-01T11:50:00Z", now)).toBe(false);
    expect(heartbeatStale("2026-01-01T11:44:00Z", now)).toBe(true);
    expect(heartbeatStale("not-a-date", now)).toBe(true);
  });
});
