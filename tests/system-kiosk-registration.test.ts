import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAppStationForDevice, registerKiosk, type SystemDeviceRow } from "@/lib/system/kiosks";
import { stationRentalUrl } from "@/lib/station-qr";
import { stationIdFromInput } from "@/lib/station-code";

vi.mock("@/lib/system/audit", () => ({ systemAudit: vi.fn() }));

type Row = Record<string, unknown>;
function fakeDb(failSlots = false) {
  const tables: Record<string, Row[]> = { system_devices: [], kiosks: [], kiosk_slots: [] };
  class Query {
    private value: Row | Row[] | null = null;
    private match: ((row: Row) => boolean) = () => true;
    private operation: "read" | "insert" | "update" | "delete" = "read";
    constructor(private table: string) {}
    select() { return this; }
    limit() { return this; }
    eq(key: string, value: unknown) { const prior = this.match; this.match = (row) => prior(row) && row[key] === value; return this; }
    in(key: string, values: unknown[]) { const prior = this.match; this.match = (row) => prior(row) && values.includes(row[key]); return this; }
    insert(value: Row | Row[]) { this.operation = "insert"; this.value = value; return this; }
    update(value: Row) { this.operation = "update"; this.value = value; return this; }
    delete() { this.operation = "delete"; return this; }
    private run() {
      const rows = tables[this.table];
      if (this.operation === "delete") {
        tables[this.table] = rows.filter((row) => !this.match(row));
        return { data: null, error: null };
      }
      if (this.operation === "insert") {
        if (this.table === "kiosk_slots" && failSlots) return { data: null, error: { message: "slot failure" } };
        const inserted = (Array.isArray(this.value) ? this.value : [this.value!]).map((row, i) => ({
          id: row.id ?? `${this.table}-${rows.length + i + 1}`, ...row,
        }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (this.operation === "update") {
        const updated = rows.filter(this.match);
        updated.forEach((row) => Object.assign(row, this.value));
        return { data: updated, error: null };
      }
      return { data: rows.filter(this.match), error: null };
    }
    single() { const result = this.run(); return { ...result, data: result.data?.[0] ?? null }; }
    maybeSingle() { return this.single(); }
    then<T>(resolve: (result: ReturnType<Query["run"]>) => T) { return Promise.resolve(this.run()).then(resolve); }
  }
  return { db: { from: (table: string) => new Query(table) } as unknown as SupabaseClient, tables };
}

const input = { serial_number: "SN-001", manufacturer: "Zapnivo", model: "ZK-1", gateway: "none", adapter_type: "none", slot_count: 4 };
const actor = { id: "staff-1", role: "admin" };

describe("system kiosk registration", () => {
  it("binds the app station, slots and scannable QR URL to the device", async () => {
    const { db, tables } = fakeDb();
    const result = await registerKiosk(db, input, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const station = tables.kiosks[0];
    expect(station).toMatchObject({ station_id: result.device.device_uid, state: "provisioning", slot_count: 4 });
    expect(tables.kiosk_slots.map((slot) => slot.slot_number)).toEqual([1, 2, 3, 4]);
    expect(stationIdFromInput(stationRentalUrl(String(station.station_id)))).toBe(station.station_id);
  });

  it("rolls back both records when slots cannot be created", async () => {
    const { db, tables } = fakeDb(true);
    const result = await registerKiosk(db, input, actor);
    expect(result.ok).toBe(false);
    expect(tables.system_devices).toHaveLength(0);
    expect(tables.kiosks).toHaveLength(0);
  });

  it("repairs an older unprovisioned device and gives it an app-compatible ID", async () => {
    const { db, tables } = fakeDb();
    const device = { id: "legacy-1", device_uid: "kiosk-9c1349bf6a9f", serial_number: "zn-2026-001213",
      status: "registered", slot_count: 8, venue_id: null, model: "ZK-1", firmware_version: "V1.0",
      provision_token_hash: null, provision_token_used_at: null, device_secret_hash: null,
      credential_issued_at: null, last_heartbeat_at: null, last_message_at: null } as SystemDeviceRow;
    tables.system_devices.push({ ...device });
    const result = await createAppStationForDevice(db, device, actor);
    expect(result).toEqual({ ok: true, stationId: "KIOSK-9C1349BF6A9F" });
    expect(tables.system_devices[0].device_uid).toBe("KIOSK-9C1349BF6A9F");
    expect(tables.kiosks[0].station_id).toBe("KIOSK-9C1349BF6A9F");
    expect(tables.kiosk_slots).toHaveLength(8);
    expect(stationIdFromInput(stationRentalUrl("KIOSK-9C1349BF6A9F"))).toBe("KIOSK-9C1349BF6A9F");
  });
});
