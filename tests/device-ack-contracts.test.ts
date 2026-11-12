import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestBodySchema, ingestKioskEvents, KNOWN_EVENT_TYPES, type IngestBody } from "@/lib/kiosk/ingest";

/**
 * Phase 2.4 — normalized device acknowledgement contract tests.
 * Covers the wire schema (all ack fields optional, legacy clients unaffected),
 * KNOWN_EVENT_TYPES coverage, and end-to-end flow of ack fields into the
 * kiosk_events ledger + immutable device_events log via the in-memory stub.
 */

type Row = Record<string, unknown>;

/** Minimal in-memory SupabaseClient — same harness shape as kiosk-lifecycle.test.ts. */
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

const KIOSK = { id: "kiosk-1", state: "online" };
const NOW = new Date("2026-02-01T12:00:00.000Z");

const baseBody = (events: unknown[]): unknown => ({ station_id: "ZP-001", events });

describe("ingestBodySchema — ack contract fields", () => {
  it("accepts a fully-populated ack event", () => {
    const res = ingestBodySchema.safeParse(baseBody([{
      event_id: "ack-1", type: "dispense_acknowledged", slot: 3,
      power_bank_serial: "SN-001", battery_pct: 95,
      at: "2026-02-01T11:59:00.000Z",
      command_id: "cmd-123", rental_ref: "ZR-ABCD1234",
      outcome: "acknowledged", error_code: "none",
      hw_timestamp: "2026-02-01T11:59:30.000Z", simulated: false,
      payload: { vendor_detail: "ok" },
    }]));
    expect(res.success).toBe(true);
    if (res.success) {
      const e = res.data.events[0];
      expect(e.command_id).toBe("cmd-123");
      expect(e.rental_ref).toBe("ZR-ABCD1234");
      expect(e.outcome).toBe("acknowledged");
      expect(e.hw_timestamp).toBe("2026-02-01T11:59:30.000Z");
      expect(e.simulated).toBe(false);
    }
  });

  it("keeps legacy events valid — every ack field is optional", () => {
    const res = ingestBodySchema.safeParse(baseBody([
      { type: "heartbeat" },
      { type: "power_bank_docked", power_bank_serial: "SN-9", at: "2026-02-01T11:00:00.000Z" },
      { type: "slot_state", slot: 2, slot_state: "ready" },
    ]));
    expect(res.success).toBe(true);
  });

  it("rejects an invalid outcome enum value", () => {
    const res = ingestBodySchema.safeParse(baseBody([
      { type: "dispense_acknowledged", outcome: "totally_fine_really" },
    ]));
    expect(res.success).toBe(false);
  });

  it("rejects a malformed hw_timestamp but accepts a missing one", () => {
    expect(ingestBodySchema.safeParse(baseBody([{ type: "hardware_fault", hw_timestamp: "not-a-date" }])).success).toBe(false);
    expect(ingestBodySchema.safeParse(baseBody([{ type: "hardware_fault" }])).success).toBe(true);
  });

  it("rejects over-long command_id / rental_ref", () => {
    expect(ingestBodySchema.safeParse(baseBody([{ type: "dispense_acknowledged", command_id: "x".repeat(121) }])).success).toBe(false);
    expect(ingestBodySchema.safeParse(baseBody([{ type: "dispense_acknowledged", rental_ref: "x".repeat(81) }])).success).toBe(false);
  });
});

describe("KNOWN_EVENT_TYPES", () => {
  it("covers baseline telemetry, verified returns and every Phase 2.4 ack type", () => {
    for (const t of [
      "heartbeat", "slot_state", "power_bank_docked", "bank_returned",
      "return_detected", "return_acknowledged",
      "dispense_requested", "dispense_acknowledged", "dispense_failed",
      "bank_released", "return_rejected", "hardware_fault",
    ]) expect(KNOWN_EVENT_TYPES.has(t)).toBe(true);
  });
});

describe("ingestKioskEvents — ack fields reach the logs", () => {
  const seed = () => ({
    kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online", last_seen_at: null }],
    power_banks: [{ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false }],
    device_commands: [{ id: "cmd-uuid-1", kiosk_id: "kiosk-1", command: "dispense", idempotency_key: "pay-1", status: "sent", payload: { rental_id: "r1" } }],
    rentals: [{ id: "r1", reference: "ZR-TEST", state: "dispense_pending", power_bank_id: "bank-1", kiosk_id: "kiosk-1", non_return_deadline: null, returned_at: null, created_at: "2026-01-01T00:00:00.000Z" }],
    kiosk_events: [], device_events: [], kiosk_slots: [], audit_logs: [], rental_exceptions: [],
  });

  it("merges ack fields into kiosk_events + device_events payloads and marks simulated", async () => {
    const { db, tables } = fakeDb(seed());
    const body: IngestBody = {
      station_id: "ZP-001",
      events: [{
        event_id: "ack-evt-1", type: "dispense_acknowledged", command_id: "pay-1",
        power_bank_serial: "SN-001", hw_timestamp: "2026-02-01T11:59:30.000Z",
        outcome: "acknowledged", simulated: true,
      }],
    };
    const res = await ingestKioskEvents(db, KIOSK, body, NOW, { notifyStarted: async () => {}, notifyReturned: async () => {} });
    expect(res.outcomes[0].result).toBe("ack_recorded");

    const kev = tables.kiosk_events[0];
    expect(kev.result).toBe("ack_recorded");
    expect((kev.payload as Row).command_id).toBe("pay-1");
    expect((kev.payload as Row).hw_timestamp).toBe("2026-02-01T11:59:30.000Z");
    expect((kev.payload as Row).simulated).toBe(true);

    const dev = tables.device_events[0];
    expect(dev.event_type).toBe("dispense_acknowledged");
    expect((dev.payload as Row).command_id).toBe("pay-1");
    expect((dev.payload as Row).simulated).toBe(true);
    // occurred_at prefers the hardware clock for ack events.
    expect(dev.occurred_at).toBe("2026-02-01T11:59:30.000Z");
  });

  it("an ack with no correlation is still accepted and logged as unmatched", async () => {
    const { db, tables } = fakeDb(seed());
    const body: IngestBody = { station_id: "ZP-001", events: [{ event_id: "ack-lone", type: "hardware_fault" }] };
    const res = await ingestKioskEvents(db, KIOSK, body, NOW);
    expect(res.outcomes[0]).toEqual({ result: "unmatched" });
    expect(tables.device_events).toHaveLength(1);
    expect(tables.kiosk_events[0].result).toBe("unmatched");
  });
});
