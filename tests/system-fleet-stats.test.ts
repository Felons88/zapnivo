import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getFleetStats, listFleetDevicesFiltered, certificationStatusByDevice,
  HEARTBEAT_STALE_MIN,
} from "@/lib/system/fleet-stats";

/**
 * Fleet stats aggregation + filtered listing. In-memory Supabase stub.
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
const fresh = new Date(NOW.getTime() - 60_000).toISOString();          // online
const stale = new Date(NOW.getTime() - (HEARTBEAT_STALE_MIN + 30) * 60_000).toISOString(); // stale

const dev = (over: Row = {}): Row => ({
  id: crypto.randomUUID(), device_uid: `DEV-${Math.random().toString(36).slice(2, 6)}`,
  serial_number: null, status: "active", last_heartbeat_at: fresh,
  firmware_version: "1.2.0", venue_id: null, region: "eu-west",
  auth_method: "hmac_sha256", device_secret_hash: "h",
  device_secret_enc: "enc", device_secret_enc_next: null,
  credential_next_expires_at: null,
  credential_issued_at: "2026-01-01T00:00:00Z",
  credential_expires_at: "2027-01-01T00:00:00Z",
  credential_revoked_at: null, last_authed_at: null, last_message_ts: null,
  ...over,
});

describe("getFleetStats", () => {
  it("aggregates real counts across all sections", async () => {
    const d1 = dev({ id: "d1", status: "active", region: "eu-west", venue_id: "v1", firmware_version: "1.2.0" });
    const d2 = dev({ id: "d2", status: "testing", region: "us-east", venue_id: null, firmware_version: "1.2.0", last_heartbeat_at: stale });
    const d3 = dev({ id: "d3", status: "suspended", region: "eu-west", venue_id: "v1", firmware_version: null, last_heartbeat_at: null,
      credential_expires_at: "2020-01-01T00:00:00Z" }); // expired credential
    const d4 = dev({ id: "d4", status: "active", region: null, venue_id: null, credential_revoked_at: "2026-01-15T00:00:00Z" });
    const { db } = fakeDb({
      system_devices: [d1, d2, d3, d4],
      venues: [{ id: "v1", name: "Hub Cafe" }],
      kiosks: [{ id: "k1", station_id: "DEV-x" }],
      device_events: [], kiosk_slots: [],
      system_device_commands: [
        { id: "c1", state: "pending" }, { id: "c2", state: "sent" }, { id: "c3", state: "acked" },
      ],
      system_certification_runs: [
        { id: "cr1", device_id: "d1", tier: "physical", status: "pass", created_at: "2026-01-30T00:00:00Z" },
        { id: "cr2", device_id: "d1", tier: "physical", status: "fail", created_at: "2026-01-20T00:00:00Z" }, // older — ignored
        { id: "cr3", device_id: "d1", tier: "simulated", status: "pass", created_at: "2026-01-25T00:00:00Z" },
        { id: "cr4", device_id: "d2", tier: "physical", status: "blocked", created_at: "2026-01-28T00:00:00Z" },
      ],
    });
    // Bind kiosk k1 to d1 via device_uid for fault detection.
    (d1 as Row).device_uid = "DEV-x";

    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    const s = res;
    expect(s.total).toBe(4);
    expect(s.by_status).toEqual({ active: 2, testing: 1, suspended: 1 });
    expect(s.connectivity.online).toBe(2);   // d1 + d4 (fresh heartbeats)
    expect(s.connectivity.stale).toBe(1);    // d2
    expect(s.connectivity.no_data).toBe(1);  // d3 (never reported)
    expect(s.pending_commands).toBe(2);
    expect(s.faulted).toBe(0);
    expect(s.credential_issues).not.toBeNull();
    expect(s.credential_issues!.expired).toBe(1);   // d3
    expect(s.credential_issues!.revoked).toBe(1);   // d4
    expect(s.firmware!["1.2.0"]).toBe(3);
    expect(s.firmware!["unknown"]).toBe(1);
    expect(s.regions!["eu-west"]).toBe(2);
    expect(s.regions!["unassigned"]).toBe(1);
    expect(s.venues!["Hub Cafe"]).toBe(2);
    expect(s.venues!["unassigned"]).toBe(2);
    // certification: latest per (device,tier) — d1 physical→pass (cr1 newer than cr2)
    expect(s.certification!.tiers.physical).toEqual({ pass: 1, blocked: 1 });
    expect(s.certification!.tiers.simulated).toEqual({ pass: 1 });
    expect(s.errors).toEqual([]);
  });

  it("counts faulted devices via bound-kiosk hardware_fault events and fault slots", async () => {
    const d1 = dev({ id: "d1", device_uid: "ST-1" });
    const d2 = dev({ id: "d2", device_uid: "ST-2" });
    const { db } = fakeDb({
      system_devices: [d1, d2],
      kiosks: [
        { id: "k1", station_id: "ST-1" },
        { id: "k2", station_id: "ST-2" },
        { id: "k3", station_id: "UNBOUND" },
      ],
      device_events: [
        { id: 1, kiosk_id: "k1", event_type: "hardware_fault", occurred_at: "2026-01-30T00:00:00Z" },
        { id: 2, kiosk_id: "k3", event_type: "hardware_fault", occurred_at: "2026-01-30T00:00:00Z" }, // unbound → ignored
        { id: 3, kiosk_id: "k2", event_type: "heartbeat", occurred_at: "2026-01-30T00:00:00Z" },
      ],
      kiosk_slots: [{ id: 9, kiosk_id: "k2", state: "fault" }],
      system_device_commands: [], system_certification_runs: [], venues: [],
    });
    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.faulted).toBe(2); // d1 (event) + d2 (fault slot)
  });

  it("returns honest section errors instead of fabricating zeros", async () => {
    const { db } = fakeDb({ system_devices: [dev()] }, { failTable: "system_device_commands" });
    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.pending_commands).toBeNull();
    expect(res.errors.some((e) => e.startsWith("pending_commands"))).toBe(true);
  });

  it("fails the whole snapshot when the device scan fails", async () => {
    const { db } = fakeDb({}, { failTable: "system_devices" });
    const res = await getFleetStats(db, NOW);
    expect("error" in res).toBe(true);
  });
});

describe("listFleetDevicesFiltered", () => {
  it("filters by connectivity derived from stored heartbeats", async () => {
    const { db } = fakeDb({
      system_devices: [
        { ...dev({ id: "a" }), created_at: "2026-01-01", venues: null },
        { ...dev({ id: "b", last_heartbeat_at: stale }), created_at: "2026-01-02", venues: null },
        { ...dev({ id: "c", last_heartbeat_at: null }), created_at: "2026-01-03", venues: null },
      ],
      venues: [],
    });
    const online = await listFleetDevicesFiltered(db, { connectivity: "online" }, NOW);
    expect(online.devices.map((d) => d.id)).toEqual(["a"]);
    const staleRes = await listFleetDevicesFiltered(db, { connectivity: "stale" }, NOW);
    expect(staleRes.devices.map((d) => d.id)).toEqual(["b"]);
    const none = await listFleetDevicesFiltered(db, { connectivity: "no_data" }, NOW);
    expect(none.devices.map((d) => d.id)).toEqual(["c"]);
  });

  it("filters by latest certification status per tier", async () => {
    const { db } = fakeDb({
      system_devices: [
        { ...dev({ id: "a" }), created_at: "2026-01-01", venues: null },
        { ...dev({ id: "b" }), created_at: "2026-01-02", venues: null },
      ],
      venues: [],
      system_certification_runs: [
        { device_id: "a", tier: "physical", status: "pass", created_at: "2026-01-30" },
        { device_id: "a", tier: "physical", status: "fail", created_at: "2026-01-10" }, // older
        { device_id: "b", tier: "physical", status: "blocked", created_at: "2026-01-28" },
      ],
    });
    const res = await listFleetDevicesFiltered(db, { cert_tier: "physical", cert_status: "pass" }, NOW);
    expect(res.devices.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("certification index helpers", () => {
  it("certificationStatusByDevice respects tier + recency", () => {
    const m = certificationStatusByDevice([
      { device_id: "a", tier: "physical", status: "pass", created_at: "2026-02-01" },
      { device_id: "a", tier: "physical", status: "fail", created_at: "2026-01-01" },
      { device_id: "a", tier: "simulated", status: "fail", created_at: "2026-01-20" },
    ], "physical");
    expect(m.get("a")).toBe("pass");
    expect(m.has("b")).toBe(false);
  });
});
