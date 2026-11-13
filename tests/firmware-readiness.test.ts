import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firmwareReadiness } from "@/lib/system/firmware-readiness";

/**
 * Firmware readiness read model — per-model compatibility + honest rollout
 * blockers. In-memory Supabase stub (same philosophy as
 * system-device-config.test.ts).
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
    private orderBy: { col: string; asc: boolean }[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy.push({ col: c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const { col, asc } of [...this.orderBy].reverse()) {
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

const ENV = "KIOSK_ADAPTER";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
});

const PROFILE = {
  id: "p-1", manufacturer: "Acme", model: "KioskPro-1",
  protocol_doc_url: "https://vendor.example/docs", gateway_api_spec: "https://vendor.example/api",
  auth_capabilities: {}, dispense_supported: true, return_detection: true,
  inventory_reporting: true, heartbeat_supported: true, firmware_update: true,
  ad_screen: false, certification_status: "certified", test_results: {},
  created_at: "2026-01-01T00:00:00Z",
};

const device = (over: Row = {}) => ({
  id: "d-1", device_uid: "ZN-1", manufacturer: "Acme", model: "KioskPro-1",
  status: "active", firmware_version: "1.2.3", created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("firmwareReadiness", () => {
  it("returns configured:false with honest blocker when db is null", async () => {
    const r = await firmwareReadiness(null);
    expect(r.configured).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.rolloutBlockers[0]).toContain("Backend not configured");
  });

  it("groups devices per model with profile match + checklist", async () => {
    const { db } = fakeDb({
      system_hardware_profiles: [PROFILE],
      system_devices: [
        device({ id: "d-1", firmware_version: "1.2.3" }),
        device({ id: "d-2", device_uid: "ZN-2", firmware_version: "1.2.3" }),
        device({ id: "d-3", device_uid: "ZN-3", firmware_version: "1.3.0", status: "maintenance" }),
        device({ id: "d-4", device_uid: "ZN-4", manufacturer: "Other", model: "Mini-9", firmware_version: null }),
      ],
    });
    const r = await firmwareReadiness(db);
    expect(r.configured).toBe(true);
    expect(r.adapter).toBe("none");
    expect(r.models).toHaveLength(2);

    const acme = r.models.find((m) => m.model === "KioskPro-1")!;
    expect(acme.deviceCount).toBe(3);
    expect(acme.profile?.certification_status).toBe("certified");
    expect(acme.certification).toBe("certified");
    expect(acme.firmwareVersions.sort()).toEqual(["1.2.3", "1.3.0"]);
    expect(acme.checklist.every((c) => c.ok)).toBe(true);

    const other = r.models.find((m) => m.model === "Mini-9")!;
    expect(other.profile).toBeNull();
    expect(other.certification).toBe("no_profile");
    expect(other.checklist.find((c) => c.item.includes("certified"))?.ok).toBe(false);
  });

  it("always reports the no-adapter + no-artifact blockers honestly", async () => {
    const { db } = fakeDb({ system_hardware_profiles: [PROFILE], system_devices: [device()] });
    const r = await firmwareReadiness(db);
    expect(r.rolloutBlockers.some((b) => b.includes("KIOSK_ADAPTER=none"))).toBe(true);
    expect(r.rolloutBlockers.some((b) => b.includes("signed firmware artifact"))).toBe(true);
  });

  it("reports missing certified profile / firmware capability blockers", async () => {
    const uncertified = { ...PROFILE, id: "p-2", certification_status: "in_review", firmware_update: false };
    const { db } = fakeDb({ system_hardware_profiles: [uncertified], system_devices: [device()] });
    const r = await firmwareReadiness(db);
    expect(r.rolloutBlockers.some((b) => b.includes("No certified hardware profile"))).toBe(true);
    expect(r.rolloutBlockers.some((b) => b.includes("firmware_update capability"))).toBe(true);
  });

  it("reflects a non-none KIOSK_ADAPTER selection without claiming dispatch works", async () => {
    // "simulator" is a recognized ADAPTER_NAMES value; unregistered vendor names
    // fall back to "none" in kioskAdapterName (selection not wired to hardware).
    process.env[ENV] = "simulator";
    const { db } = fakeDb({ system_hardware_profiles: [], system_devices: [] });
    const r = await firmwareReadiness(db);
    expect(r.adapter).toBe("simulator");
    expect(r.rolloutBlockers.some((b) => b.includes('KIOSK_ADAPTER="simulator"'))).toBe(true);
    expect(r.rolloutBlockers.some((b) => b.includes("No devices registered"))).toBe(true);
  });

  it("passes through version groups from firmwareInventory", async () => {
    const { db } = fakeDb({
      system_hardware_profiles: [],
      system_devices: [device({ firmware_version: "2.0.0" }), device({ id: "d-2", device_uid: "ZN-2", firmware_version: null })],
    });
    const r = await firmwareReadiness(db);
    expect(r.versionGroups.map((g) => g.version).sort()).toEqual(["2.0.0", "unknown"]);
    expect(r.totalDevices).toBe(2);
  });
});
