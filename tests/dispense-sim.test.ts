import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  advanceSimDispenses, dispenseStatusFor, issueDispenseCommand, runDispenseSweep,
} from "@/lib/kiosk/dispatch";

/**
 * Dispense dispatch tests — issueDispenseCommand idempotency, the test-kiosk
 * sim plan running through the REAL ingest → lifecycle pipeline, normalized
 * customer-stage derivation, and the catch-up sweep.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
    power_banks: ["serial"],
    kiosk_slots: ["kiosk_id,slot_number"],
    system_device_messages: ["device_id,message_id"],
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
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    or() { return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }
    filter() { return this; }

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
          if (row.id == null) row.id = this.name === "system_devices" ? randomUUID() : `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
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
    private finish() { return this.run(); }
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

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const NOW = new Date("2026-03-01T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

function seed(opts: { testMode?: boolean; scenario?: string; rentalState?: string; createdAt?: string } = {}) {
  const { db, tables } = fakeDb({
    system_devices: [], kiosks: [], device_events: [], kiosk_events: [],
    kiosk_slots: [], power_banks: [], rentals: [], device_commands: [],
    rental_exceptions: [], audit_logs: [],
  });
  tables.kiosks.push({
    id: "k1", station_id: "SIM-0001", state: "online",
    test_mode: opts.testMode ?? false, test_scenario: opts.scenario ?? null,
  });
  tables.rentals.push({
    id: "r1", reference: "ZR-TEST-1", state: opts.rentalState ?? "dispense_pending",
    kiosk_id: "k1", bank_count: 1, created_at: opts.createdAt ?? new Date(NOW.getTime() - 60_000).toISOString(),
  });
  return { db, tables };
}

describe("issueDispenseCommand", () => {
  it("issues exactly one durable command — replays are safe no-ops", async () => {
    const { db, tables } = seed({ testMode: true });
    const first = await issueDispenseCommand(db, "r1", { now: NOW });
    const second = await issueDispenseCommand(db, "r1", { now: NOW });
    expect(first.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(tables.device_commands).toHaveLength(1);
    const cmd = tables.device_commands[0];
    expect(cmd.idempotency_key).toBe("dispense:r1");
    expect(cmd.command).toBe("dispense");
    expect((cmd.payload as Row).rental_id).toBe("r1");
    expect((cmd.payload as Row).sim).toBeTruthy();
  });

  it("refuses rentals that have not reached dispense_pending", async () => {
    const { db, tables } = seed({ rentalState: "authorized" });
    const res = await issueDispenseCommand(db, "r1", { now: NOW });
    expect(res.ok).toBe(false);
    expect(tables.device_commands).toHaveLength(0);
  });

  it("production kiosks get a real queued command with NO sim plan", async () => {
    const { db, tables } = seed({ testMode: false });
    await issueDispenseCommand(db, "r1", { now: NOW });
    expect((tables.device_commands[0].payload as Row).sim).toBeUndefined();
    // Nothing advances a real kiosk without a transport adapter — honest.
    const { emitted } = await advanceSimDispenses(db, at(30_000));
    expect(emitted).toBe(0);
    const st = await dispenseStatusFor(db, { id: "r1", state: "dispense_pending", kiosk_id: "k1" });
    expect(st.stage).toBe("preparing");
    expect(st.simulated).toBe(false);
  });
});

describe("simulated dispense via the real ingest pipeline", () => {
  it("success scenario walks staged events → command acknowledged → rental active", async () => {
    const { db, tables } = seed({ testMode: true, scenario: "success" });
    await issueDispenseCommand(db, "r1", { now: NOW });

    const stages: string[] = [];
    for (const t of [1_500, 6_000, 12_500, 22_000]) {
      await advanceSimDispenses(db, at(t));
      const st = await dispenseStatusFor(db, { id: "r1", state: (tables.rentals[0].state as string), kiosk_id: "k1" });
      stages.push(st.stage);
    }
    expect(stages).toEqual(["releasing", "dispensing", "almost_ready", "ready"]);
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.device_commands[0].status).toBe("acknowledged");
    // Every emitted event is honestly marked simulated.
    expect(tables.device_events.length).toBeGreaterThanOrEqual(4);
    for (const e of tables.device_events) {
      expect((e.payload as Row).simulated).toBe(true);
    }
  });

  it("jam scenario → failed stage, rental stays dispense_pending (no fake success)", async () => {
    const { db, tables } = seed({ testMode: true, scenario: "jam" });
    await issueDispenseCommand(db, "r1", { now: NOW });
    for (const t of [1_500, 6_000, 13_500]) await advanceSimDispenses(db, at(t));
    const st = await dispenseStatusFor(db, { id: "r1", state: tables.rentals[0].state as string, kiosk_id: "k1" });
    expect(st.stage).toBe("failed");
    expect(st.errorCode).toBe("slot_jam");
    expect(tables.rentals[0].state).toBe("dispense_pending");
    expect(tables.device_commands[0].status).toBe("failed");
  });

  it("empty kiosk reports no_inventory failure fast", async () => {
    const { db, tables } = seed({ testMode: true, scenario: "empty" });
    await issueDispenseCommand(db, "r1", { now: NOW });
    await advanceSimDispenses(db, at(2_500));
    const st = await dispenseStatusFor(db, { id: "r1", state: tables.rentals[0].state as string, kiosk_id: "k1" });
    expect(st.stage).toBe("failed");
    expect(st.errorCode).toBe("no_inventory");
  });

  it("duplicate_ack replays are deduplicated — rental activates exactly once", async () => {
    const { db, tables } = seed({ testMode: true, scenario: "duplicate_ack" });
    await issueDispenseCommand(db, "r1", { now: NOW });
    for (const t of [1_500, 6_000, 12_500, 22_000, 26_000]) await advanceSimDispenses(db, at(t));
    expect(tables.rentals[0].state).toBe("active");
    const releases = tables.device_events.filter((e) => e.event_type === "bank_released");
    expect(releases.length).toBeGreaterThanOrEqual(1); // deduped replays stay out of the raw log
    expect(tables.device_commands[0].status).toBe("acknowledged");
  });

  it("lost_ack / offline never resend — command stays open for reconciliation", async () => {
    const { db, tables } = seed({ testMode: true, scenario: "lost_ack" });
    await issueDispenseCommand(db, "r1", { now: NOW });
    for (const t of [1_500, 6_000, 12_500, 60_000]) await advanceSimDispenses(db, at(t));
    // Stages ran out — no second command, no fabricated release.
    expect(tables.device_commands.filter((c) => c.command === "dispense")).toHaveLength(1);
    expect(tables.rentals[0].state).toBe("dispense_pending");
  });
});

describe("dispenseStatusFor — normalized customer stage", () => {
  it("verifying when paid but no command yet; connecting before that", async () => {
    const { db } = seed();
    expect((await dispenseStatusFor(db, { id: "r1", state: "dispense_pending" })).stage).toBe("verifying");
    expect((await dispenseStatusFor(db, { id: "r1", state: "authorized" })).stage).toBe("connecting");
    expect((await dispenseStatusFor(db, { id: "r1", state: "active" })).stage).toBe("ready");
  });
});

describe("runDispenseSweep", () => {
  it("backfills a missing command for a stale dispense_pending rental", async () => {
    const { db, tables } = seed({ createdAt: new Date(NOW.getTime() - 120_000).toISOString() });
    const res = await runDispenseSweep(db, NOW);
    expect(res.issued).toBe(1);
    expect(tables.device_commands).toHaveLength(1);
    // A second sweep must NOT double-issue.
    const again = await runDispenseSweep(db, NOW);
    expect(again.issued).toBe(0);
    expect(tables.device_commands).toHaveLength(1);
  });
});
