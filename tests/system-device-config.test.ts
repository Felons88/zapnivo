import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateDesiredConfig, sanitizeReportedConfig, desiredEquals,
  proposeConfig, approveConfig, dispatchConfig, reconcileReported, proposeRollback,
  assignDeviceTags, sanitizeTags, configRisk,
  canTransitionVisit, visitTransitionPatch, MAINTENANCE_TRANSITIONS,
  CONFIG_KEYS, type ConfigRevisionRow,
} from "@/lib/system/device-config";
import type { SystemDeviceRow } from "@/lib/system/kiosks";

/**
 * Device desired-state config + maintenance workflow (migration 0059).
 * In-memory Supabase stub — same philosophy as command-ops.test.ts.
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
    single() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    maybeSingle() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = { id: "op-1", role: "sysadmin" };
const DEV = {
  id: "11111111-1111-4111-8111-111111111111",
  device_uid: "DEV-001", serial_number: "SN-1", status: "active",
} as unknown as SystemDeviceRow;

const rev = (over: Row = {}): Row => ({
  id: `rev-${Math.random().toString(36).slice(2, 8)}`, device_id: DEV.id,
  revision: 1, desired: { maintenance_mode: false }, status: "draft",
  command_id: null, reported: null, actor: ACTOR.id, created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("validateDesiredConfig — whitelist", () => {
  it("accepts whitelisted keys with valid values", () => {
    const r = validateDesiredConfig({ heartbeat_interval_sec: 60, maintenance_mode: true, brightness: 50, ad_playlist_id: "pl-1", config_notes: "note" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.desired).toEqual({ heartbeat_interval_sec: 60, maintenance_mode: true, brightness: 50, ad_playlist_id: "pl-1", config_notes: "note" });
  });
  it("rejects unknown keys", () => {
    const r = validateDesiredConfig({ maintenance_mode: true, dispense_slot: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("unknown config key");
  });
  it("rejects wrong types and out-of-range values", () => {
    expect(validateDesiredConfig({ heartbeat_interval_sec: 5 }).ok).toBe(false); // below min 15
    expect(validateDesiredConfig({ heartbeat_interval_sec: 1.5 }).ok).toBe(false); // not int
    expect(validateDesiredConfig({ brightness: 101 }).ok).toBe(false);
    expect(validateDesiredConfig({ maintenance_mode: "yes" }).ok).toBe(false);
    expect(validateDesiredConfig({ config_notes: "x".repeat(2001) }).ok).toBe(false);
    expect(validateDesiredConfig(null).ok).toBe(false);
    expect(validateDesiredConfig({}).ok).toBe(false);
  });
  it("allows nullable clears for ad_playlist_id/config_notes", () => {
    const r = validateDesiredConfig({ ad_playlist_id: null, config_notes: null });
    expect(r.ok).toBe(true);
  });
  it("exposes exactly the documented whitelist", () => {
    expect(CONFIG_KEYS.sort()).toEqual(["ad_playlist_id", "brightness", "config_notes", "heartbeat_interval_sec", "maintenance_mode"]);
  });
});

describe("config revision lifecycle", () => {
  it("proposeConfig creates a draft revision r1 and bumps revision", async () => {
    const { db, tables } = fakeDb({ device_config_revisions: [], system_audit_events: [], system_device_commands: [] });
    const r1 = await proposeConfig(db, DEV, { maintenance_mode: true }, ACTOR);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.revision.status).toBe("draft");
    const r2 = await proposeConfig(db, DEV, { brightness: 40 }, ACTOR);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.revision.revision).toBe(2);
    expect(tables.device_config_revisions).toHaveLength(2);
  });

  it("proposeConfig rejects non-eligible device statuses", async () => {
    const { db } = fakeDb({ device_config_revisions: [], system_audit_events: [] });
    const suspended = { ...DEV, status: "suspended" } as SystemDeviceRow;
    const r = await proposeConfig(db, suspended, { brightness: 50 }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("approveConfig approves a draft and supersedes older open revisions", async () => {
    const { db, tables } = fakeDb({
      device_config_revisions: [
        rev({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, status: "draft", desired: { brightness: 10 } }),
        rev({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revision: 2, status: "draft", desired: { brightness: 20 } }),
      ],
      system_audit_events: [], system_change_requests: [],
    });
    const r = await approveConfig(db, DEV, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.revision.status).toBe("approved");
    const a = tables.device_config_revisions.find((x) => x.id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!;
    expect(a.status).toBe("superseded");
  });

  it("configRisk marks maintenance_mode medium, display keys low", () => {
    expect(configRisk({ maintenance_mode: true })).toBe("medium");
    expect(configRisk({ brightness: 50 })).toBe("low");
    expect(configRisk({ brightness: 50, maintenance_mode: false })).toBe("medium");
  });

  it("dispatchConfig records an honest failed command with adapter=none and links it", async () => {
    const { db, tables } = fakeDb({
      device_config_revisions: [rev({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", revision: 3, status: "approved", desired: { maintenance_mode: true } })],
      system_device_commands: [], system_audit_events: [],
    });
    const r = await dispatchConfig(db, DEV, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispatched).toBe(false);
    expect(r.revision.status).toBe("failed");
    const cmd = tables.system_device_commands[0];
    expect(cmd.command_type).toBe("config_update");
    expect(cmd.state).toBe("failed"); // never 'sent'/'acked' without a live adapter
    expect((cmd.result as Row).reason).toBe("adapter_disabled");
    expect(r.revision.command_id).toBe(cmd.id);
  });

  it("dispatchConfig refuses non-approved revisions", async () => {
    const { db } = fakeDb({ device_config_revisions: [rev({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "draft" })], system_audit_events: [] });
    const r = await dispatchConfig(db, DEV, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("reconcileReported marks a matching report applied", async () => {
    const { db, tables } = fakeDb({
      device_config_revisions: [rev({ id: "e1", revision: 4, status: "awaiting_report", desired: { brightness: 70, maintenance_mode: false } })],
      system_audit_events: [],
    });
    const r = await reconcileReported(db, DEV, { brightness: 70, maintenance_mode: false, rogue_key: "x" }, ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.matched).toBe(true); expect(r.revision.status).toBe("applied"); }
    const stored = tables.device_config_revisions[0];
    expect((stored.reported as Row).rogue_key).toBeUndefined(); // whitelist-filtered
  });

  it("reconcileReported keeps awaiting_report on mismatch", async () => {
    const { db } = fakeDb({
      device_config_revisions: [rev({ id: "e2", revision: 5, status: "awaiting_report", desired: { brightness: 70 } })],
      system_audit_events: [],
    });
    const r = await reconcileReported(db, DEV, { brightness: 10 }, ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.matched).toBe(false); expect(r.revision.status).toBe("awaiting_report"); }
  });

  it("proposeRollback creates a draft restoring the previously applied desired", async () => {
    const { db } = fakeDb({
      device_config_revisions: [
        rev({ id: "r1", revision: 1, status: "applied", desired: { brightness: 90 } }),
        rev({ id: "r2", revision: 2, status: "applied", desired: { brightness: 30 } }),
      ],
      system_audit_events: [],
    });
    const r = await proposeRollback(db, DEV, ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.revision.status).toBe("draft");
      expect(r.revision.revision).toBe(3);
      expect(r.revision.desired).toEqual({ brightness: 90 });
    }
  });

  it("proposeRollback refuses when fewer than two applied revisions exist", async () => {
    const { db } = fakeDb({
      device_config_revisions: [rev({ id: "r1", revision: 1, status: "applied", desired: { brightness: 90 } })],
      system_audit_events: [],
    });
    const r = await proposeRollback(db, DEV, ACTOR);
    expect(r.ok).toBe(false);
  });
});

describe("assignDeviceTags", () => {
  it("writes metadata.tags and preserves other metadata keys", async () => {
    const { db, tables } = fakeDb({
      system_devices: [{ id: DEV.id, metadata: { owner: "ops" } }],
      system_audit_events: [],
    });
    const r = await assignDeviceTags(db, DEV, ["lobby", "pilot", "lobby"], ACTOR);
    expect(r.ok).toBe(true);
    const meta = tables.system_devices[0].metadata as Row;
    expect(meta.tags).toEqual(["lobby", "pilot"]);
    expect(meta.owner).toBe("ops");
  });
  it("sanitizeTags rejects non-arrays and caps length", () => {
    expect(sanitizeTags("nope")).toBeNull();
    expect(sanitizeTags([1, 2])).toBeNull();
    expect(sanitizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))!.length).toBe(20);
  });
});

describe("sanitizeReportedConfig / desiredEquals", () => {
  it("drops non-whitelisted reported keys and bad values", () => {
    const s = sanitizeReportedConfig({ brightness: 55, evil: "x", heartbeat_interval_sec: "bad" });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.reported).toEqual({ brightness: 55 });
  });
  it("desiredEquals compares whitelisted values", () => {
    expect(desiredEquals({ a: undefined } as never, {} as never)).toBe(true);
    expect(desiredEquals({ brightness: 1 }, { brightness: 1 })).toBe(true);
    expect(desiredEquals({ brightness: 1 }, { brightness: 2 })).toBe(false);
  });
});

describe("maintenance visit workflow", () => {
  it("allows the documented edges and blocks illegal ones", () => {
    expect(canTransitionVisit("open", "scheduled")).toBe(true);
    expect(canTransitionVisit("scheduled", "in_progress")).toBe(true);
    expect(canTransitionVisit("in_progress", "completed")).toBe(true);
    expect(canTransitionVisit("completed", "open")).toBe(false);
    expect(canTransitionVisit("cancelled", "scheduled")).toBe(false);
    expect(MAINTENANCE_TRANSITIONS.open).toContain("cancelled");
  });
  it("visitTransitionPatch sets lifecycle timestamps", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(visitTransitionPatch("in_progress", now).started_at).toBe(now.toISOString());
    expect(visitTransitionPatch("completed", now).completed_at).toBe(now.toISOString());
    expect(visitTransitionPatch("scheduled", now).started_at).toBeUndefined();
  });
});
