import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BASELINE_EVENT_TYPES, capabilitiesFromDeviceRecord, requiredCapabilityFor,
  resolveDeviceCapabilities,
} from "@/lib/kiosk/capabilities";
import { ingestKioskEvents, KNOWN_EVENT_TYPES, type IngestBody } from "@/lib/kiosk/ingest";

/**
 * Phase 2.5 — server-side capability enforcement on kiosk event ingest.
 * Same in-memory SupabaseClient stub philosophy as tests/kiosk-lifecycle.test.ts.
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

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const KIOSK = { id: "kiosk-1", station_id: "ZP-001", state: "online" };
const NOW = new Date("2026-01-01T02:05:00.000Z");
const T0 = "2026-01-01T00:00:00.000Z";

const rental = (over: Row = {}): Row => ({
  id: "r1", reference: "ZR-TEST", state: "active", power_bank_id: "bank-1", kiosk_id: "kiosk-1",
  return_kiosk_id: null, non_return_deadline: null, returned_at: null, return_disputed: false,
  non_return_fee_status: "none", created_at: T0, ...over,
});
const bank = (over: Row = {}): Row => ({ id: "bank-1", serial: "SN-001", battery_pct: 80, current_kiosk: "kiosk-1", retired: false, ...over });

function seedDb(extra: Record<string, Row[]> = {}) {
  return fakeDb({
    kiosks: [{ id: "kiosk-1", station_id: "ZP-001", state: "online", last_seen_at: null }],
    rentals: [rental()],
    power_banks: [bank()],
    kiosk_slots: [], device_events: [], kiosk_events: [], audit_logs: [],
    system_devices: [], system_hardware_profiles: [],
    ...extra,
  });
}

const dockEvent = {
  event_id: "ev-dock-1", type: "power_bank_docked", power_bank_serial: "SN-001",
  slot: 1, at: "2026-01-01T02:00:00.000Z",
};
const body = (events: Row[]): IngestBody => ({ station_id: "ZP-001", events: events as IngestBody["events"] });

/* ══════════════════════════════════════════════════════════════════════
 * Capability model — mapping coverage + normalization
 * ══════════════════════════════════════════════════════════════════════ */
describe("capability model", () => {
  it("every KNOWN_EVENT_TYPE is either baseline or capability-gated", () => {
    for (const t of KNOWN_EVENT_TYPES) {
      const req = requiredCapabilityFor(t);
      if (req == null) expect(BASELINE_EVENT_TYPES.has(t) || !KNOWN_EVENT_TYPES.has(t)).toBe(true);
    }
    // Explicit mapping assertions.
    expect(requiredCapabilityFor("heartbeat")).toBeNull();
    expect(requiredCapabilityFor("hardware_fault")).toBeNull();
    expect(requiredCapabilityFor("slot_state")).toBe("inventory_report");
    expect(requiredCapabilityFor("power_bank_docked")).toBe("return_detect");
    expect(requiredCapabilityFor("bank_returned")).toBe("return_detect");
    expect(requiredCapabilityFor("return_detected")).toBe("return_detect");
    expect(requiredCapabilityFor("return_acknowledged")).toBe("return_detect");
    expect(requiredCapabilityFor("return_rejected")).toBe("return_detect");
    expect(requiredCapabilityFor("dispense_requested")).toBe("dispense");
    expect(requiredCapabilityFor("dispense_acknowledged")).toBe("dispense");
    expect(requiredCapabilityFor("dispense_failed")).toBe("dispense");
    expect(requiredCapabilityFor("bank_released")).toBe("dispense");
  });

  it("unknown event types require no capability (pass-through, logged 'ignored')", () => {
    expect(requiredCapabilityFor("vendor_custom_ping")).toBeNull();
    expect(requiredCapabilityFor("")).toBeNull();
  });

  it("normalizes stored capability shapes: arrays, maps, nested containers, aliases", () => {
    expect([...capabilitiesFromDeviceRecord(["dispense", "return-detect"])]).toEqual(
      expect.arrayContaining(["dispense", "return_detect"]),
    );
    expect(capabilitiesFromDeviceRecord({ dispense: true, return_detection: false }).has("dispense")).toBe(true);
    expect(capabilitiesFromDeviceRecord({ dispense: true }).has("return_detect")).toBe(false); // falsy never grants
    expect(capabilitiesFromDeviceRecord({ capabilities: ["inventory_report"] }).has("inventory_report")).toBe(true);
    expect(capabilitiesFromDeviceRecord({ features: { "dock_detect": true } }).has("return_detect")).toBe(true);
    expect(capabilitiesFromDeviceRecord(null).size).toBe(0);
    expect(capabilitiesFromDeviceRecord(undefined).size).toBe(0);
    expect(capabilitiesFromDeviceRecord({}).size).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * resolveDeviceCapabilities — stored records only + certified profile join
 * ══════════════════════════════════════════════════════════════════════ */
describe("resolveDeviceCapabilities", () => {
  it("returns empty set for missing source (fail-closed)", async () => {
    const { db } = seedDb();
    expect((await resolveDeviceCapabilities(db, null)).size).toBe(0);
  });

  it("joins a certified system_hardware_profiles row matched by manufacturer+model", async () => {
    const { db } = seedDb({
      system_hardware_profiles: [{
        id: "p1", manufacturer: "Acme", model: "Kiosk-9000", certification_status: "certified",
        dispense_supported: true, return_detection: true, inventory_reporting: false,
        heartbeat_supported: true, firmware_update: false, ad_screen: false,
      }],
    });
    const caps = await resolveDeviceCapabilities(db, { manufacturer: "Acme", model: "Kiosk-9000", capabilities: {} });
    expect(caps.has("dispense")).toBe(true);
    expect(caps.has("return_detect")).toBe(true);
    expect(caps.has("heartbeat")).toBe(true);
    expect(caps.has("inventory_report")).toBe(false); // profile says false
  });

  it("ignores uncertified profiles and non-matching models", async () => {
    const { db } = seedDb({
      system_hardware_profiles: [{
        id: "p1", manufacturer: "Acme", model: "Kiosk-9000", certification_status: "in_review",
        dispense_supported: true, return_detection: true, inventory_reporting: true,
        heartbeat_supported: true, firmware_update: true, ad_screen: true,
      }],
    });
    const caps = await resolveDeviceCapabilities(db, { manufacturer: "Acme", model: "Kiosk-9000" });
    expect(caps.size).toBe(0);
    const caps2 = await resolveDeviceCapabilities(db, { manufacturer: "Acme", model: "Other-1" });
    expect(caps2.size).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ingestKioskEvents enforcement
 * ══════════════════════════════════════════════════════════════════════ */
describe("ingestKioskEvents — capability enforcement", () => {
  it("device WITH return_detect accepts a dock and completes the rental", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([dockEvent]), NOW, {}, new Set(["return_detect"]));
    expect(res.accepted).toBe(1);
    expect(res.denied).toHaveLength(0);
    expect(res.outcomes[0]).toEqual({ result: "returned", rentalId: "r1" });
    expect(tables.rentals[0]).toMatchObject({ state: "returned" });
    expect(tables.kiosk_events).toHaveLength(1);
  });

  it("device WITHOUT the capability is denied per-event: no kiosk_events claim, no rental effect, marker logged", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([dockEvent]), NOW, {}, new Set(["heartbeat"]));
    expect(res.accepted).toBe(0);
    expect(res.outcomes).toHaveLength(0);
    expect(res.denied).toEqual([
      { index: 0, event_id: "ev-dock-1", type: "power_bank_docked", required_capability: "return_detect" },
    ]);
    // Immutable raw log carries the denial marker — the security audit trail.
    expect(tables.device_events).toHaveLength(1);
    expect(tables.device_events[0]).toMatchObject({ event_type: "power_bank_docked", kiosk_id: "kiosk-1" });
    expect((tables.device_events[0].payload as Row).denied_reason).toBe("capability_denied");
    expect((tables.device_events[0].payload as Row).required_capability).toBe("return_detect");
    // Nothing reached the lifecycle: no claim row, no slot projection, no bank upsert.
    expect(tables.kiosk_events ?? []).toHaveLength(0);
    expect(tables.kiosk_slots).toHaveLength(0);
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.rentals[0].returned_at).toBeNull();
  });

  it("empty capability set is fail-closed: gated types denied, baseline allowed", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([
      { event_id: "hb-1", type: "heartbeat", at: T0 },
      { event_id: "slot-1", type: "slot_state", slot: 1, slot_state: "ready" },
      { event_id: "dock-1", type: "power_bank_docked", power_bank_serial: "SN-001" },
    ]), NOW, {}, new Set());
    expect(res.accepted).toBe(1); // heartbeat only
    expect(res.denied.map((d) => d.type)).toEqual(["slot_state", "power_bank_docked"]);
    expect(res.outcomes).toEqual([{ result: "heartbeat" }]);
    expect(tables.kiosk_slots).toHaveLength(0); // denied slot_state did not project
  });

  it("heartbeat and hardware_fault are baseline — always allowed even with zero capabilities", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([
      { event_id: "hb-1", type: "heartbeat", at: T0 },
      { event_id: "flt-1", type: "hardware_fault", error_code: "motor_stall", at: T0 },
    ]), NOW, {}, new Set());
    expect(res.denied).toHaveLength(0);
    expect(res.accepted).toBe(2);
    // hardware_fault is an ack-type → lifecycle records 'unmatched' (no command/rental/bank).
    expect(res.outcomes.map((o) => o.result)).toEqual(["heartbeat", "unmatched"]);
    const faultRow = tables.device_events.find((e) => e.event_type === "hardware_fault");
    expect(faultRow).toBeTruthy();
    expect((faultRow!.payload as Row).denied_reason).toBeUndefined();
  });

  it("self-reported capabilities in the event payload are never consulted", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([{
      event_id: "ack-1", type: "dispense_acknowledged",
      command_id: "cmd-1", payload: { capabilities: ["dispense"], caps: ["dispense", "return_detect"] },
      at: T0,
    }]), NOW, {}, new Set()); // device holds NO capabilities
    expect(res.denied).toHaveLength(1);
    expect(res.denied[0].required_capability).toBe("dispense");
    expect(res.outcomes).toHaveLength(0);
    // The stored payload is preserved verbatim on the denial row (audit), but
    // it bought the device nothing.
    const row = tables.device_events.find((e) => e.event_type === "dispense_acknowledged");
    expect((row!.payload as Row).denied_reason).toBe("capability_denied");
    expect(tables.device_commands ?? []).toHaveLength(0);
  });

  it("unknown event types pass through unenforced and are logged 'ignored'", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([
      { event_id: "x-1", type: "vendor_custom_ping", payload: { whatever: true }, at: T0 },
    ]), NOW, {}, new Set());
    expect(res.denied).toHaveLength(0);
    expect(res.accepted).toBe(1);
    expect(res.outcomes[0]).toEqual({ result: "ignored" });
    const row = tables.device_events.find((e) => e.event_type === "vendor_custom_ping");
    expect((row!.payload as Row).denied_reason).toBeUndefined();
  });

  it("mixed batch: baseline + authorized + denied coexist; only denied are skipped", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([
      { event_id: "hb-1", type: "heartbeat", at: T0 },
      { event_id: "inv-1", type: "slot_state", slot: 2, slot_state: "empty" }, // needs inventory_report — absent
      dockEvent,                                                                          // needs return_detect — present
    ]), NOW, {}, new Set(["return_detect"]));
    expect(res.accepted).toBe(2);
    expect(res.denied).toHaveLength(1);
    expect(res.denied[0].type).toBe("slot_state");
    expect(res.outcomes.map((o) => o.result)).toEqual(["heartbeat", "returned"]);
    expect(tables.rentals[0].state).toBe("returned");
    expect(tables.kiosk_slots).toHaveLength(0); // the denied slot_state projected nothing
  });

  it("omitted capabilities arg = enforcement OFF (backward compat for simulator/tests)", async () => {
    const { db, tables } = seedDb();
    const res = await ingestKioskEvents(db, KIOSK, body([dockEvent]), NOW, {});
    expect(res.denied).toHaveLength(0);
    expect(res.outcomes[0]).toEqual({ result: "returned", rentalId: "r1" });
    expect(tables.rentals[0].state).toBe("returned");
  });

  it("route-equivalent path: capabilities resolved from a stored stationDevice record gate the same ingest", async () => {
    // Mirrors /api/devices/events: legacy shared-secret path resolves caps via
    // findStationDevice → resolveDeviceCapabilities → ingestKioskEvents.
    const stationDeviceRow = {
      capabilities: { dispense: true }, manufacturer: null, model: null,
    };
    const { db, tables } = seedDb();
    const caps = await resolveDeviceCapabilities(db, stationDeviceRow);
    const res = await ingestKioskEvents(db, KIOSK, body([
      { event_id: "d-1", type: "dispense_acknowledged", command_id: "c-1", rental_ref: "ZR-TEST", outcome: "acknowledged", at: T0 },
      { event_id: "d-2", type: "bank_released", command_id: "c-2", at: T0 },
    ]), NOW, {}, caps);
    // dispense granted by the stored record; bank_released also needs 'dispense' → allowed.
    expect(res.denied).toHaveLength(0);
    expect(res.accepted).toBe(2);
    // A device row with NO capabilities field → same ingest denies gated types.
    const { db: db2, tables: t2 } = seedDb();
    const caps2 = await resolveDeviceCapabilities(db2, { capabilities: null, manufacturer: null, model: null });
    const res2 = await ingestKioskEvents(db2, KIOSK, body([
      { event_id: "d-3", type: "bank_released", at: T0 },
      { event_id: "h-1", type: "heartbeat", at: T0 },
    ]), NOW, {}, caps2);
    expect(res2.denied.map((d) => d.type)).toEqual(["bank_released"]);
    expect(res2.accepted).toBe(1);
    expect(t2.device_events.some((e) => (e.payload as Row).denied_reason === "capability_denied")).toBe(true);
  });
});
