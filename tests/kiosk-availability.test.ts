import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  stationMaintenanceBlock, NON_SERVING_DEVICE_STATUSES,
  OPEN_MAINTENANCE_VISIT_STATUSES, MAINTENANCE_CONFIG_ACTIVE_STATUSES,
} from "@/lib/kiosk/availability";

/**
 * Rental-side maintenance gate (src/lib/kiosk/availability.ts).
 * In-memory Supabase stub — same philosophy as system-device-config.test.ts.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
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
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    maybeSingle() {
      const { data } = this.run();
      return { data: (data as Row[])[0] ?? null, error: null };
    }
    single() { return this.maybeSingle(); }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const DEV = { id: "dev-1", device_uid: "ZN-001", serial_number: "SN-001", status: "active" };
const STATION = "ZN-001"; // resolves via device_uid

const device = (over: Row = {}) => ({ ...DEV, ...over });
const visit = (over: Row = {}) => ({
  id: "v-1", device_id: "dev-1", status: "open", ...over,
});
const rev = (over: Row = {}) => ({
  device_id: "dev-1", revision: 1, status: "applied",
  desired: { maintenance_mode: true }, ...over,
});

describe("stationMaintenanceBlock", () => {
  it("returns null when no system_devices row is bound to the station", async () => {
    const { db } = fakeDb({ system_devices: [] });
    expect(await stationMaintenanceBlock(db, "NOPE-1")).toBeNull();
  });

  it("returns null for an active device with no visits or config", async () => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [],
      device_config_revisions: [],
    });
    expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
  });

  it("resolves the device by serial_number when device_uid does not match", async () => {
    const { db } = fakeDb({
      system_devices: [device({ status: "maintenance" })],
      system_maintenance_visits: [],
      device_config_revisions: [],
    });
    const b = await stationMaintenanceBlock(db, "SN-001");
    expect(b?.reason).toBe("device_status");
  });

  it.each([...NON_SERVING_DEVICE_STATUSES])("blocks device_status='%s'", async (status) => {
    const { db } = fakeDb({
      system_devices: [device({ status })],
      system_maintenance_visits: [],
      device_config_revisions: [],
    });
    const b = await stationMaintenanceBlock(db, STATION);
    expect(b?.reason).toBe("device_status");
    expect(b?.detail).toContain(status);
  });

  it.each(["pending", "registered", "provisioning", "testing", "active"])(
    "does NOT block serving-capable status '%s' on device_status grounds", async (status) => {
      const { db } = fakeDb({
        system_devices: [device({ status })],
        system_maintenance_visits: [],
        device_config_revisions: [],
      });
      expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
    });

  it.each([...OPEN_MAINTENANCE_VISIT_STATUSES])("blocks on open visit status '%s'", async (status) => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [visit({ status })],
      device_config_revisions: [],
    });
    expect((await stationMaintenanceBlock(db, STATION))?.reason).toBe("maintenance_visit");
  });

  it.each(["completed", "cancelled"])("does NOT block on closed visit status '%s'", async (status) => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [visit({ status })],
      device_config_revisions: [],
    });
    expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
  });

  it.each([...MAINTENANCE_CONFIG_ACTIVE_STATUSES])(
    "blocks on accepted config revision status '%s' with maintenance_mode=true", async (status) => {
      const { db } = fakeDb({
        system_devices: [device()],
        system_maintenance_visits: [],
        device_config_revisions: [rev({ status })],
      });
      expect((await stationMaintenanceBlock(db, STATION))?.reason).toBe("maintenance_config");
    });

  it.each(["draft", "failed", "superseded"])(
    "does NOT block on unaccepted config revision status '%s'", async (status) => {
      const { db } = fakeDb({
        system_devices: [device()],
        system_maintenance_visits: [],
        device_config_revisions: [rev({ status })],
      });
      expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
    });

  it("does NOT block when accepted revision sets maintenance_mode=false", async () => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [],
      device_config_revisions: [rev({ desired: { maintenance_mode: false } })],
    });
    expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
  });

  it("a newer draft proposing maintenance_mode=false does NOT unblock an older applied true", async () => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [],
      device_config_revisions: [
        rev({ revision: 2, status: "draft", desired: { maintenance_mode: false } }),
        rev({ revision: 1, status: "applied", desired: { maintenance_mode: true } }),
      ],
    });
    expect((await stationMaintenanceBlock(db, STATION))?.reason).toBe("maintenance_config");
  });

  it("an applied rollback to maintenance_mode=false DOES unblock", async () => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [],
      device_config_revisions: [
        rev({ revision: 2, status: "applied", desired: { maintenance_mode: false } }),
        rev({ revision: 1, status: "applied", desired: { maintenance_mode: true } }),
      ],
    });
    expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
  });

  it("ignores config revisions belonging to a different device", async () => {
    const { db } = fakeDb({
      system_devices: [device()],
      system_maintenance_visits: [],
      device_config_revisions: [rev({ device_id: "other-dev", status: "applied" })],
    });
    expect(await stationMaintenanceBlock(db, STATION)).toBeNull();
  });
});
