import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  devAuth: () => false,
  isStaff: (u: { role?: string } | null) => u?.role === "admin",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { POST } from "@/app/api/system/kiosks/bulk/route";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Bulk kiosk ops — safe-subset guard + per-device honest results.
 * In-memory Supabase stub (same philosophy as command-ops.test.ts).
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
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
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          const row: Row = { ...item };
          if (row.id == null) row.id = this.name === "device_config_revisions" || this.name === "system_device_commands"
            ? crypto.randomUUID() : `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
          rows.push(row); out.push(row);
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
    single() { const { data } = this.finish(); const rows = Array.isArray(data) ? data : data ? [data] : []; return { data: rows[0] ?? null, error: null }; }
    maybeSingle() { const { data } = this.finish(); const rows = Array.isArray(data) ? data : data ? [data] : []; return { data: rows[0] ?? null, error: null }; }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = { id: "op-1", role: "sysadmin" };
const DEV1 = "11111111-1111-4111-8111-111111111111";
const DEV2 = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";

function seedDb() {
  return {
    profiles: [{ id: ACTOR.id, system_role: "sysadmin", system_suspended: false }],
    system_devices: [
      { id: DEV1, device_uid: "DEV-1", serial_number: "S1", status: "active", metadata: {}, capabilities: {}, last_heartbeat_at: null, manufacturer: "A", model: "M", credential_revoked_at: null },
      { id: DEV2, device_uid: "DEV-2", serial_number: "S2", status: "testing", metadata: { tags: ["old"] }, capabilities: {}, last_heartbeat_at: null, manufacturer: "A", model: "M", credential_revoked_at: null },
    ],
    device_config_revisions: [], system_device_commands: [],
    system_audit_events: [], system_change_requests: [], system_hardware_profiles: [],
  };
}

function req(body: unknown) {
  return new Request("http://localhost/api/system/kiosks/bulk", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("POST /api/system/kiosks/bulk — action guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    session.mockResolvedValue({ id: ACTOR.id, role: "staff", email: "op@zapnivo.com" });
  });

  it("rejects physical/dispatch actions with 403", async () => {
    const { db } = fakeDb(seedDb());
    service.mockReturnValue(db);
    for (const action of ["dispense", "reboot", "unlock_slot", "return_slot", "firmware_update", "config_update"]) {
      const res = await POST(req({ action, device_ids: [DEV1] }));
      expect(res.status).toBe(403);
      const j = await res.json();
      expect(j.allowed_actions).toContain("assign_tags");
    }
  });

  it("rejects unknown actions with 400", async () => {
    const { db } = fakeDb(seedDb());
    service.mockReturnValue(db);
    const res = await POST(req({ action: "nuke_fleet", device_ids: [DEV1] }));
    expect(res.status).toBe(400);
  });

  it("assign_tags updates metadata per device with honest partial results", async () => {
    const { db, tables } = fakeDb(seedDb());
    service.mockReturnValue(db);
    const res = await POST(req({ action: "assign_tags", device_ids: [DEV1, DEV2, MISSING], tags: ["pilot", "lobby"] }));
    expect(res.status).toBe(207); // partial — MISSING not found
    const j = await res.json();
    expect(j.succeeded).toBe(2);
    expect(j.failed).toBe(1);
    expect(j.results.find((r: { device_id: string }) => r.device_id === MISSING).ok).toBe(false);
    const d1 = tables.system_devices.find((r) => r.id === DEV1)!;
    expect((d1.metadata as Row).tags).toEqual(["pilot", "lobby"]);
    const d2 = tables.system_devices.find((r) => r.id === DEV2)!;
    expect((d2.metadata as Row).tags).toEqual(["pilot", "lobby"]);
    expect((d2.metadata as Row).owner).toBeUndefined(); // no owner key — tags only
  });

  it("schedule_diagnostics records a diagnostic_ping command per device", async () => {
    const { db, tables } = fakeDb(seedDb());
    service.mockReturnValue(db);
    const res = await POST(req({ action: "schedule_diagnostics", device_ids: [DEV1, DEV2] }));
    const j = await res.json();
    expect(j.succeeded).toBe(2);
    const cmds = tables.system_device_commands.filter((c) => c.command_type === "diagnostic_ping");
    expect(cmds).toHaveLength(2);
    // adapter=none → recorded failed/adapter_disabled, never 'sent'
    expect(cmds.every((c) => c.state === "failed")).toBe(true);
  });

  it("set_maintenance_flag runs the config pipeline and records honest dispatch", async () => {
    const { db, tables } = fakeDb(seedDb());
    service.mockReturnValue(db);
    const res = await POST(req({ action: "set_maintenance_flag", device_ids: [DEV1], maintenance_mode: true }));
    expect(res.status).toBe(200); // all devices processed successfully (revision 'failed' is the honest dispatch outcome)
    const j = await res.json();
    // propose+approve+dispatch all succeed as operations; revision status 'failed' is honest
    expect(j.results[0].ok).toBe(true);
    const revs = tables.device_config_revisions;
    expect(revs).toHaveLength(1);
    expect(revs[0].status).toBe("failed");
    expect(revs[0].desired).toEqual({ maintenance_mode: true });
    const cmds = tables.system_device_commands.filter((c) => c.command_type === "config_update");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].state).toBe("failed");
  });
});
