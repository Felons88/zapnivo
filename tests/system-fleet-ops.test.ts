import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getFleetStats, HEARTBEAT_STALE_MIN } from "@/lib/system/fleet-stats";
import {
  FLEET_LIVE_TABLES, FLEET_LIVE_CHANNEL, fleetRealtimeBindings,
  formatFleetRefreshTime, isFleetDataStale,
} from "@/lib/system/fleet-live";

/**
 * Phase 4.2 fleet ops aggregates (maintenance / provisioning / certification
 * coverage / auth failures / command outcomes / config drift / battery
 * inventory / open exceptions) + fleet-live pure helpers.
 * In-memory Supabase stub — same shape as tests/system-fleet-stats.test.ts.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}, opts: { failTable?: string } = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert() { return this; }
    update() { return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }
    private run() {
      if (opts.failTable === this.name) return { data: null, error: { message: `forced ${this.name} failure` } };
      let out = ensure(this.name).filter((r) => this.filters.every((f) => f(r)));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    single() { const { data } = this.run(); const rows = Array.isArray(data) ? data : data ? [data] : []; return { data: rows[0] ?? null, error: null }; }
    maybeSingle() { const { data } = this.run(); const rows = Array.isArray(data) ? data : data ? [data] : []; return { data: rows[0] ?? null, error: null }; }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const NOW = new Date("2026-02-01T12:00:00Z");
const fresh = new Date(NOW.getTime() - 60_000).toISOString();
const dayAgo = new Date(NOW.getTime() - 25 * 3_600_000).toISOString(); // outside 24h window
const kioskStaleAt = new Date(NOW.getTime() - (HEARTBEAT_STALE_MIN + 30) * 60_000).toISOString();

const dev = (over: Row = {}): Row => ({
  id: crypto.randomUUID(), device_uid: `DEV-${Math.random().toString(36).slice(2, 6)}`,
  serial_number: null, status: "active", last_heartbeat_at: fresh,
  firmware_version: "1.2.0", venue_id: null, region: "eu-west",
  auth_method: "hmac_sha256", device_secret_hash: "h",
  credential_issued_at: "2026-01-01T00:00:00Z",
  credential_expires_at: "2027-01-01T00:00:00Z",
  credential_revoked_at: null, last_authed_at: null, last_message_ts: null,
  ...over,
});

/** Seed covering every new section at once. */
function fullSeed(): Record<string, Row[]> {
  return {
    system_devices: [
      dev({ id: "d-maint", status: "maintenance" }),
      dev({ id: "d-pend", status: "pending" }),
      dev({ id: "d-reg", status: "registered" }),
      dev({ id: "d-prov", status: "provisioning" }),
      dev({ id: "d-certfail" }),
      dev({ id: "d-certok" }),
      dev({ id: "d-never" }),
    ],
    venues: [],
    // Legacy fleet rows — unbound station_ids keep the faulted section empty.
    kiosks: [
      { id: "k1", station_id: null, last_seen_at: fresh },
      { id: "k2", station_id: null, last_seen_at: kioskStaleAt },
      { id: "k3", station_id: null, last_seen_at: null },
    ],
    kiosk_slots: [
      { kiosk_id: "k1", state: "empty" }, { kiosk_id: "k1", state: "charging" },
      { kiosk_id: "k2", state: "ready" }, { kiosk_id: "k2", state: "fault" },
    ],
    power_banks: [
      { id: "b1", battery_pct: 80, retired: false },
      { id: "b2", battery_pct: null, retired: false }, // unknown pct
      { id: "b3", battery_pct: null, retired: true },  // retired AND unknown pct
      { id: "b4", battery_pct: 12, retired: false },
    ],
    device_events: [],
    system_device_commands: [
      { id: "c1", state: "pending", created_at: fresh },
      { id: "c2", state: "failed", created_at: fresh },
      { id: "c3", state: "timeout", created_at: fresh },
      { id: "c4", state: "failed", created_at: dayAgo },  // outside 24h
      { id: "c5", state: "acked", created_at: fresh },
    ],
    system_certification_runs: [
      // d-certfail: latest physical = fail → without_pass
      { device_id: "d-certfail", tier: "physical", status: "fail", created_at: "2026-01-30T00:00:00Z" },
      { device_id: "d-certfail", tier: "physical", status: "pass", created_at: "2026-01-20T00:00:00Z" }, // older — ignored
      // d-certok: physical + simulated both pass on latest → certified
      { device_id: "d-certok", tier: "physical", status: "pass", created_at: "2026-01-30T00:00:00Z" },
      { device_id: "d-certok", tier: "simulated", status: "pass", created_at: "2026-01-29T00:00:00Z" },
    ],
    system_maintenance_visits: [
      { id: "v1", status: "open" }, { id: "v2", status: "scheduled" },
      { id: "v3", status: "in_progress" }, { id: "v4", status: "completed" },
      { id: "v5", status: "cancelled" },
    ],
    system_device_messages: [
      { id: "m1", result: "rejected", received_at: fresh },
      { id: "m2", result: "rejected", received_at: fresh },
      { id: "m3", result: "rejected", received_at: dayAgo }, // outside 24h
      { id: "m4", result: "ok", received_at: fresh },
    ],
    device_config_revisions: [
      // d-certok rev2 (latest): reported mismatches desired on brightness → drift
      { device_id: "d-certok", revision: 2, desired: { brightness: 50 }, status: "applied", reported: { brightness: 80 } },
      { device_id: "d-certok", revision: 1, desired: { brightness: 50 }, status: "applied", reported: { brightness: 50 } }, // superseded
      // d-certfail rev1 (latest): awaiting_report, reported null → awaiting, NOT drift
      { device_id: "d-certfail", revision: 1, desired: { heartbeat_interval_sec: 60 }, status: "awaiting_report", reported: null },
      // d-never rev3 (latest): applied + matching reported → neither
      { device_id: "d-never", revision: 3, desired: { brightness: 10 }, status: "applied", reported: { brightness: 10 } },
    ],
    rental_exceptions: [
      { id: "e1", status: "open" }, { id: "e2", status: "new" },
      { id: "e3", status: "investigating" }, { id: "e4", status: "resolved" },
      { id: "e5", status: "dismissed" }, { id: "e6", status: "reopened" },
    ],
  };
}

describe("getFleetStats — phase 4.2 ops sections", () => {
  it("aggregates all new sections from real rows", async () => {
    const { db } = fakeDb(fullSeed());
    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    const s = res;

    // maintenance: 1 device in 'maintenance'; 3 non-terminal visits
    expect(s.maintenance).toEqual({ devices: 1, open_visits: 3 });
    // provisioning pipeline: pending + registered + provisioning (testing NOT included)
    expect(s.provisioning_pending).toBe(3);
    // certification: no running state exists → coverage counts.
    // without_pass = devices with runs but a non-pass latest tier (d-certfail only);
    // never_tested = devices with zero runs (d-maint, d-pend, d-reg, d-prov, d-never).
    expect(s.certification_active).toEqual({ without_pass: 1, never_tested: 5 });
    // auth failures: rejected messages in last 24h only
    expect(s.auth_failures).toBe(2);
    // command outcomes: failed/timeout created in last 24h (c4 too old, c5 wrong state)
    expect(s.command_outcomes_24h).toEqual({ failed: 1, timeout: 1 });
    expect(s.pending_commands).toBe(1);
    // config drift: latest revision per device only
    expect(s.config_drift).toEqual({ mismatched: 1, awaiting_report: 1 });
    // battery inventory: legacy rental fleet (kiosks/kiosk_slots/power_banks)
    expect(s.battery_inventory).toEqual({
      kiosks_total: 3,
      kiosks_stale: 2, // k2 stale heartbeat + k3 never seen
      slots_by_state: { empty: 1, charging: 1, ready: 1, fault: 1 },
      banks_total: 4,
      banks_retired: 1,
      banks_unknown_pct: 2, // b2 + b3 (b3 is retired AND unknown)
    });
    // open exceptions: everything except resolved/dismissed
    expect(s.open_exceptions).toBe(4);
    expect(s.errors).toEqual([]);
  });

  it("reports honest nulls per failed section instead of fabricated zeros", async () => {
    for (const [table, check] of [
      ["system_maintenance_visits", (s: any) => expect(s.maintenance).toEqual({ devices: 1, open_visits: null })],
      ["system_device_messages", (s: any) => expect(s.auth_failures).toBeNull()],
      ["system_device_commands", (s: any) => { expect(s.command_outcomes_24h).toBeNull(); expect(s.pending_commands).toBeNull(); }],
      ["device_config_revisions", (s: any) => expect(s.config_drift).toBeNull()],
      ["power_banks", (s: any) => expect(s.battery_inventory).toBeNull()],
      ["rental_exceptions", (s: any) => expect(s.open_exceptions).toBeNull()],
      ["system_certification_runs", (s: any) => { expect(s.certification).toBeNull(); expect(s.certification_active).toBeNull(); }],
    ] as [string, (s: any) => void][]) {
      const seed = fullSeed();
      // keep exactly one maintenance-status device for the maintenance.devices fallback
      const { db } = fakeDb(seed, { failTable: table });
      const res = await getFleetStats(db, NOW);
      expect("error" in res, `snapshot should survive ${table} failure`).toBe(false);
      if ("error" in res) continue;
      check(res);
      expect(res.errors.some((e) => e.includes(table))).toBe(true);
    }
  });

  it("empty fleet yields honest zeros, not nulls, for derivable sections", async () => {
    const { db } = fakeDb({ system_devices: [dev()] });
    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.provisioning_pending).toBe(0);
    expect(res.maintenance).toEqual({ devices: 0, open_visits: 0 });
    expect(res.open_exceptions).toBe(0);
    expect(res.battery_inventory).toMatchObject({ kiosks_total: 0, banks_total: 0 });
    expect(res.certification_active).toEqual({ without_pass: 0, never_tested: 1 });
  });
});

describe("fleet-live helpers", () => {
  it("binds exactly the three fleet tables for postgres_changes", () => {
    const bindings = fleetRealtimeBindings();
    expect(bindings.map((b) => b.table).sort()).toEqual([...FLEET_LIVE_TABLES].sort());
    for (const b of bindings) {
      expect(b.event).toBe("*");
      expect(b.schema).toBe("public");
    }
    expect(FLEET_LIVE_CHANNEL).toBe("system-fleet-live");
  });

  it("isFleetDataStale flags old/missing refresh timestamps", () => {
    const now = new Date("2026-02-01T12:00:00Z");
    expect(isFleetDataStale(null, now)).toBe(true);
    expect(isFleetDataStale("not-a-date", now)).toBe(true);
    expect(isFleetDataStale("2026-02-01T11:58:30Z", now, 60_000)).toBe(true);  // 90s old
    expect(isFleetDataStale("2026-02-01T11:59:30Z", now, 60_000)).toBe(false); // 30s old
    expect(isFleetDataStale("2026-02-01T11:59:00Z", now, 60_000)).toBe(false); // exactly 60s → not stale
  });

  it("formatFleetRefreshTime renders HH:MM:SSZ honestly", () => {
    expect(formatFleetRefreshTime("2026-02-01T12:34:56.789Z")).toBe("12:34:56Z");
    expect(formatFleetRefreshTime(null)).toBe("—");
    expect(formatFleetRefreshTime("garbage")).toBe("—");
  });
});
