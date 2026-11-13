import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* Route-level mocks (hoisted) — same pattern as system-certification.test.ts. */
const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  devAuth: () => false,
  isStaff: (u: { role?: string } | null) => u?.role === "admin",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { POST as REQUEUE } from "@/app/api/system/commands/[id]/requeue/route";
import { GET as LIST } from "@/app/api/system/commands/route";
import { GET as DETAIL } from "@/app/api/system/commands/[id]/route";
import {
  requeueDeviceCommand, listCommandHistory, getCommandDetail, getDeviceOpsDashboard,
  sanitizePayload, commandKeyLineage, COMMAND_REQUIRED_CAPABILITY,
} from "@/lib/system/command-ops";
import { resetRateLimits } from "@/lib/rate-limit";
import type { SystemDeviceRow } from "@/lib/system/kiosks";

/**
 * Phase 2.6 — controlled command retries + command history + device ops dashboard.
 * Same in-memory Supabase stub philosophy as command-ack-integrity.test.ts.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    kiosk_events: ["event_id"],
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
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert() { return this; }
    delete() { return this; }
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

    private run(): { data: Row[] | Row | null; error: { code: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "update") {
        if (this.op === "update") {
          const affected = rows.filter(match);
          for (const r of affected) Object.assign(r, this.payload as Row);
          return { data: affected, error: null };
        }
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
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

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const ACTOR = { id: "op-1", email: "op@zapnivo.com", role: "staff", organizationId: null };
const KIOSK = { id: "kiosk-1", station_id: "DEV-001", state: "online", venue_id: null, slot_count: 8, last_seen_at: null, firmware_version: "1.0", model: "Z1", created_at: "2026-01-01T00:00:00Z" };
const KIOSK2 = { id: "kiosk-2", station_id: "DEV-002", state: "online", venue_id: null, slot_count: 8, last_seen_at: null, firmware_version: "1.0", model: "Z1", created_at: "2026-01-01T00:00:00Z" };
const DEVICE_UUID = "66666666-6666-4666-8666-666666666666";
const DEVICE2_UUID = "77777777-7777-4777-8777-777777777777";
const CMD_ID = "33333333-3333-4333-8333-333333333333";
const CMD2_ID = "55555555-5555-4555-8555-555555555555";
const EXC_ID = "99999999-9999-4999-8999-999999999999";
const NOW_ISO = "2026-02-01T12:00:00.000Z";

const device = (over: Row = {}): Row => ({
  id: DEVICE_UUID, device_uid: "DEV-001", serial_number: "SN-001",
  status: "active", credential_revoked_at: null,
  capabilities: { dispense: true, "return-detect": true },
  manufacturer: "ACME", model: "Z1",
  last_heartbeat_at: "2026-02-01T11:58:00.000Z",
  credential_issued_at: "2026-01-01T00:00:00Z", credential_expires_at: "2027-01-01T00:00:00Z",
  ...over,
});

const device2 = (over: Row = {}): Row => device({
  id: DEVICE2_UUID, device_uid: "DEV-002", serial_number: "SN-002", ...over,
});

const cmd = (over: Row = {}): Row => ({
  id: CMD_ID, kiosk_id: "kiosk-1", command: "reboot", idempotency_key: "rb-1",
  status: "failed", payload: { note: "test" }, issued_by: ACTOR.id,
  created_at: "2026-02-01T10:00:00.000Z", resolved_at: "2026-02-01T10:05:00.000Z",
  expires_at: null, expected_response_types: null, resolved_outcome: "failed",
  attempt_count: 0, last_transition_at: "2026-02-01T10:05:00.000Z",
  ...over,
});

function seedDb(opts: { role?: string; elevation?: boolean; deviceOver?: Row; commands?: Row[] } = {}) {
  const { db, tables } = fakeDb({
    profiles: [{ id: ACTOR.id, system_role: opts.role ?? "sysadmin", system_suspended: false }],
    kiosks: [KIOSK, KIOSK2],
    system_devices: [device(opts.deviceOver), device2()],
    device_commands: opts.commands ?? [cmd()],
    device_events: [], kiosk_events: [], kiosk_slots: [], power_banks: [],
    rental_exceptions: [], rentals: [], audit_logs: [], system_audit_events: [],
    system_elevations: opts.elevation
      ? [{
          id: "elev-1", profile_id: ACTOR.id, method: "totp",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          consumed_action: null, created_ip: null,
        }]
      : [],
    system_hardware_profiles: [], system_certification_runs: [], maintenance_visits: [],
  });
  return { db, tables };
}

const requeueReq = (id: string, body: unknown) =>
  new Request(`http://localhost/api/system/commands/${id}/requeue`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const VALID_BODY = { confirm: true, reason: "Hardware confirmed failure on-site; slot verified empty." };

beforeEach(() => {
  resetRateLimits();
  session.mockResolvedValue(ACTOR);
});

/* ── Pure helpers ──────────────────────────────────────────────────────── */

describe("command-ops pure helpers", () => {
  it("command → capability map covers physical commands honestly", () => {
    expect(COMMAND_REQUIRED_CAPABILITY.dispense).toBe("dispense");
    expect(COMMAND_REQUIRED_CAPABILITY.return_slot).toBe("return_detect");
    expect(COMMAND_REQUIRED_CAPABILITY.unlock_slot).toBe("dispense");
    expect(COMMAND_REQUIRED_CAPABILITY.reboot).toBeNull();
  });

  it("sanitizePayload strips credential/header-shaped keys recursively", () => {
    const out = sanitizePayload({
      rental_id: "r1", api_key: "sekrit", nested: { password: "pw", signature: "sig", ok: 1 },
      list: [{ token: "t", fine: "x" }],
    }) as Record<string, unknown>;
    expect(out.rental_id).toBe("r1");
    expect(out.api_key).toBeUndefined();
    expect((out.nested as Record<string, unknown>).password).toBeUndefined();
    expect((out.nested as Record<string, unknown>).signature).toBeUndefined();
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect(((out.list as Record<string, unknown>[])[0]).token).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("sekrit");
  });

  it("commandKeyLineage derives prior idempotency keys", () => {
    const lin = commandKeyLineage({ id: "c", idempotency_key: "pay-1:r2", attempt_count: 2 });
    expect(lin.baseKey).toBe("pay-1");
    expect(lin.allKeys).toEqual(["pay-1", "pay-1:r1", "pay-1:r2"]);
    const fresh = commandKeyLineage({ id: "c", idempotency_key: "k", attempt_count: 0 });
    expect(fresh.allKeys).toEqual(["k"]);
  });
});

/* ── POST requeue: permission + elevation gates ────────────────────────── */

describe("POST /api/system/commands/[id]/requeue — gates", () => {
  it("viewer role → 403", async () => {
    const { db } = seedDb({ role: "viewer" });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(403);
  });

  it("physical command without elevation → 403 step_up_required", async () => {
    const { db, tables } = seedDb({
      elevation: false,
      commands: [cmd({ command: "dispense", idempotency_key: "disp-1" })],
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
    expect(tables.device_commands[0].status).toBe("failed"); // untouched
  });

  it("non-physical command does NOT require elevation", async () => {
    const { db, tables } = seedDb({ elevation: false });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(200);
    expect(tables.device_commands[0].status).toBe("queued");
  });

  it("physical + elevation but no allowPhysical → 409 physical_requires_review", async () => {
    const { db } = seedDb({
      elevation: true,
      commands: [cmd({ command: "unlock_slot", idempotency_key: "unl-1" })],
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("physical_requires_review");
  });

  it("physical + elevation + allowPhysical → 200, fresh :rN key", async () => {
    const { db, tables } = seedDb({
      elevation: true,
      commands: [cmd({ command: "dispense", idempotency_key: "disp-1", attempt_count: 0 })],
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.attempt).toBe(1);
    expect(tables.device_commands[0]).toMatchObject({
      status: "queued", idempotency_key: "disp-1:r1", attempt_count: 1,
    });
  });

  it("rejects missing confirm / short reason (zod)", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const r1 = await REQUEUE(requeueReq(CMD_ID, { reason: VALID_BODY.reason }), ctx(CMD_ID));
    expect(r1.status).toBe(400);
    const r2 = await REQUEUE(requeueReq(CMD_ID, { confirm: true, reason: "short" }), ctx(CMD_ID));
    expect(r2.status).toBe(400);
  });
});

/* ── POST requeue: state machine + device gates ────────────────────────── */

describe("POST requeue — state & device gates", () => {
  it("unknown_outcome → 409 requires_investigation_escalation", async () => {
    const { db } = seedDb({ commands: [cmd({ status: "unknown_outcome", command: "reboot" })] });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("requires_investigation_escalation");
  });

  it("acknowledged (terminal) → 409 illegal_state", async () => {
    const { db } = seedDb({ commands: [cmd({ status: "acknowledged", command: "reboot" })] });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("illegal_state");
  });

  it("unknown command id → 404", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq("44444444-4444-4444-8444-444444444444", VALID_BODY), ctx("44444444-4444-4444-8444-444444444444"));
    expect(res.status).toBe(404);
  });

  it("suspended device → 409 device_not_eligible", async () => {
    const { db } = seedDb({ deviceOver: { status: "suspended" } });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("device_not_eligible");
  });

  it("revoked credential → 409 credential_revoked", async () => {
    const { db } = seedDb({ deviceOver: { credential_revoked_at: "2026-01-15T00:00:00Z" } });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("credential_revoked");
  });

  it("device without the required capability → 409 capability_not_supported", async () => {
    const { db } = seedDb({
      elevation: true,
      deviceOver: { capabilities: { "return-detect": true } }, // no dispense
      commands: [cmd({ command: "dispense", idempotency_key: "disp-9" })],
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("capability_not_supported");
  });
});

/* ── POST requeue: evidence gate for dispense/return_slot ──────────────── */

describe("requeue evidence — dispense/return_slot", () => {
  const dispense = (over: Row = {}) => cmd({ command: "dispense", idempotency_key: "disp-1", status: "failed", resolved_outcome: "failed", ...over });

  it("failed dispense with NO contradictory ack → requeues without evidence", async () => {
    const { db } = seedDb({ elevation: true, commands: [dispense()] });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(200);
  });

  it("positive ack correlated → 409 insufficient_evidence without evidence_ref", async () => {
    const { db } = seedDb({
      elevation: true, commands: [dispense()],
    });
    await db.from("device_events").insert({
      kiosk_id: "kiosk-1", event_type: "dispense_acknowledged",
      payload: { command_id: CMD_ID, outcome: "acknowledged" }, occurred_at: NOW_ISO,
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("insufficient_evidence");
  });

  it("contradictory ack + resolved rental_exceptions evidence_ref → 200", async () => {
    const { db } = seedDb({
      elevation: true, commands: [dispense()],
    });
    await db.from("device_events").insert({
      kiosk_id: "kiosk-1", event_type: "dispense_acknowledged",
      payload: { command_id: CMD_ID, outcome: "acknowledged" }, occurred_at: NOW_ISO,
    });
    await db.from("rental_exceptions").insert({
      id: EXC_ID, kiosk_id: "kiosk-1", kind: "conflicting_ack", status: "resolved",
      detail: { command_id: CMD_ID }, created_at: NOW_ISO,
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true, evidence_ref: EXC_ID }), ctx(CMD_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.evidence.kind).toBe("rental_exception");
  });

  it("timeout dispense (dispatched, outcome unknown) requires evidence even without ack", async () => {
    const { db } = seedDb({
      elevation: true, commands: [dispense({ status: "timeout", resolved_outcome: "timeout" })],
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true }), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("insufficient_evidence");
  });

  it("timeout dispense + failure-ack device_events id as evidence_ref → 200", async () => {
    const { db } = seedDb({
      elevation: true, commands: [dispense({ status: "timeout", resolved_outcome: "timeout" })],
    });
    await db.from("device_events").insert({
      id: 501, kiosk_id: "kiosk-1", event_type: "dispense_failed",
      payload: { command_id: CMD_ID, outcome: "failed", error_code: "motor_stall" }, occurred_at: NOW_ISO,
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true, evidence_ref: "501" }), ctx(CMD_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.evidence.kind).toBe("device_event");
  });

  it("unresolved exception is NOT valid evidence → 409", async () => {
    const { db } = seedDb({
      elevation: true, commands: [dispense({ status: "timeout", resolved_outcome: "timeout" })],
    });
    await db.from("rental_exceptions").insert({
      id: EXC_ID, kiosk_id: "kiosk-1", kind: "conflicting_ack", status: "open",
      detail: { command_id: CMD_ID }, created_at: NOW_ISO,
    });
    service.mockReturnValue(db);
    const res = await REQUEUE(requeueReq(CMD_ID, { ...VALID_BODY, allowPhysical: true, evidence_ref: EXC_ID }), ctx(CMD_ID));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("insufficient_evidence");
  });
});

/* ── Idempotency + audit ──────────────────────────────────────────────── */

describe("requeue idempotency + audit", () => {
  it("double-submit does not double-queue (second → 409 illegal_state)", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    const r1 = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(r1.status).toBe(200);
    const r2 = await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    expect(r2.status).toBe(409);
    expect(tables.device_commands).toHaveLength(1);
    expect(tables.device_commands[0].attempt_count).toBe(1);
  });

  it("writes kiosk.command_requeued to system_audit_events with resource device_command:<id>", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    await REQUEUE(requeueReq(CMD_ID, VALID_BODY), ctx(CMD_ID));
    const audit = tables.system_audit_events as Row[];
    const ev = audit.find((a) => a.action === "kiosk.command_requeued");
    expect(ev).toBeTruthy();
    expect(ev!.resource).toBe(`device_command:${CMD_ID}`);
    expect((ev!.detail as Row).reason).toContain("Hardware confirmed");
  });
});

/* ── GET list: filters ────────────────────────────────────────────────── */

describe("GET /api/system/commands — history filters", () => {
  const commands = () => [
    cmd({ id: CMD_ID, command: "dispense", status: "failed", kiosk_id: "kiosk-1", idempotency_key: "d1", created_at: "2026-02-01T10:00:00Z" }),
    cmd({ id: CMD2_ID, command: "reboot", status: "acknowledged", kiosk_id: "kiosk-2", idempotency_key: "r2", created_at: "2026-02-01T11:00:00Z" }),
    cmd({ id: "88888888-8888-4888-8888-888888888888", command: "dispense", status: "queued", kiosk_id: "kiosk-1", idempotency_key: "d3", created_at: "2026-02-01T09:00:00Z", payload: { rental_id: "rent-1" } }),
  ];

  it("filters by state + command", async () => {
    const { db } = seedDb({ commands: commands() });
    service.mockReturnValue(db);
    const res = await LIST(new Request("http://localhost/api/system/commands?state=failed&command=dispense"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.count).toBe(1);
    expect(j.commands[0].id).toBe(CMD_ID);
  });

  it("device_id resolves to bound kiosk(s) via station binding", async () => {
    const { db } = seedDb({ commands: commands() });
    service.mockReturnValue(db);
    const res = await LIST(new Request(`http://localhost/api/system/commands?device_id=${DEVICE_UUID}`));
    const j = await res.json();
    expect(j.scope.kiosk_ids).toEqual(["kiosk-1"]);
    expect(j.commands.every((c: { kiosk_id: string }) => c.kiosk_id === "kiosk-1")).toBe(true);
    expect(j.commands).toHaveLength(2);
  });

  it("unbound device_id → empty + unbound_device flag", async () => {
    const { db } = seedDb({ commands: commands(), deviceOver: { device_uid: "NOPE", serial_number: "NOPE2" } });
    service.mockReturnValue(db);
    const res = await LIST(new Request(`http://localhost/api/system/commands?device_id=${DEVICE_UUID}`));
    const j = await res.json();
    expect(j.count).toBe(0);
    expect(j.scope.unbound_device).toBe(true);
  });

  it("kiosk_id scope + bogus state → 400", async () => {
    const K2_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { db } = seedDb({
      commands: [...commands(), cmd({ id: "12121212-1212-4212-8212-121212121212", kiosk_id: K2_UUID, idempotency_key: "k2-1" })],
    });
    service.mockReturnValue(db);
    const res = await LIST(new Request("http://localhost/api/system/commands?state=bogus"));
    expect(res.status).toBe(400);
    const res2 = await LIST(new Request(`http://localhost/api/system/commands?kiosk_id=${K2_UUID}`));
    const j2 = await res2.json();
    expect(j2.commands).toHaveLength(1);
    expect(j2.commands[0].kiosk_id).toBe(K2_UUID);
  });

  it("viewer CAN list (view perm)", async () => {
    const { db } = seedDb({ role: "viewer", commands: commands() });
    service.mockReturnValue(db);
    const res = await LIST(new Request("http://localhost/api/system/commands"));
    expect(res.status).toBe(200);
  });
});

/* ── GET detail ────────────────────────────────────────────────────────── */

describe("GET /api/system/commands/[id] — detail", () => {
  it("404 for unknown id", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await DETAIL(new Request("http://x"), ctx("44444444-4444-4444-8444-444444444444"));
    expect(res.status).toBe(404);
  });

  it("returns sanitized payload, ack events, retry lineage, audit", async () => {
    const { db, tables } = seedDb({
      elevation: true,
      commands: [cmd({
        command: "dispense", idempotency_key: "disp-1", status: "timeout",
        attempt_count: 1, resolved_outcome: "timeout",
        payload: { rental_id: "rent-1", api_key: "SHH", signature: "sig" },
      })],
    });
    await db.from("device_events").insert({
      id: 77, kiosk_id: "kiosk-1", event_type: "dispense_failed",
      payload: { command_id: "disp-1:r1", outcome: "failed", error_code: "motor_stall" },
      occurred_at: NOW_ISO,
    });
    await db.from("rentals").insert({ id: "rent-1", reference: "ZR-1", state: "dispense_pending" });
    service.mockReturnValue(db);

    const res = await DETAIL(new Request("http://x"), ctx(CMD_ID));
    expect(res.status).toBe(200);
    const j = await res.json();
    const d = j.command;
    expect(d.command.status).toBe("timeout");
    // sanitized payload
    expect(d.command.payload.api_key).toBeUndefined();
    expect(d.command.payload.signature).toBeUndefined();
    expect(d.command.payload.rental_id).toBe("rent-1");
    // ack correlation by :rN lineage
    expect(d.ack_events).toHaveLength(1);
    expect(d.ack_events[0].classification).toBe("negative");
    // retry lineage
    expect(d.retry.idempotency_keys).toEqual(["disp-1", "disp-1:r1"]);
    expect(d.retry.requeueable).toBe(true);
    // rental link
    expect(d.rental.id).toBe("rent-1");
    // system device binding surfaced
    expect(d.system_device.id).toBe(DEVICE_UUID);
    expect(tables.device_events).toHaveLength(1);
  });
});

/* ── Dashboard assembly ────────────────────────────────────────────────── */

describe("getDeviceOpsDashboard", () => {
  it("assembles bound-kiosk sections with honest verification signals", async () => {
    const { db } = seedDb({
      commands: [
        cmd({ id: CMD_ID, command: "dispense", status: "failed", kiosk_id: "kiosk-1" }),
        cmd({ id: CMD2_ID, command: "reboot", status: "unknown_outcome", kiosk_id: "kiosk-1" }),
      ],
    });
    await db.from("device_events").insert({
      id: 1, kiosk_id: "kiosk-1", event_type: "heartbeat",
      payload: {}, occurred_at: "2026-02-01T11:59:00Z",
    });
    await db.from("rental_exceptions").insert({
      id: EXC_ID, kiosk_id: "kiosk-1", kind: "command_timeout", status: "open",
      detail: { command_id: CMD2_ID }, created_at: NOW_ISO,
    });
    const dash = await getDeviceOpsDashboard(db, device() as unknown as SystemDeviceRow, new Date("2026-02-01T12:00:00Z"));
    expect(dash.unbound).toBe(false);
    expect(dash.bound_kiosks.map((k) => k.id)).toContain("kiosk-1");
    expect(dash.commands.counts).toMatchObject({ open: 0, failed: 1, unknown_or_investigation: 1, total: 2 });
    expect(dash.hardware_events).toHaveLength(1);
    expect(dash.exceptions).toHaveLength(1);
    // heartbeat was 1 min ago → yes; gateway honestly unverifiable; no physical cert
    expect(dash.verification.heartbeat_received.state).toBe("yes");
    expect(dash.verification.gateway_reachable.state).toBe("unverifiable");
    expect(dash.verification.physically_verified.state).toBe("no");
    expect(dash.certification.physical_latest).toBeNull();
  });

  it("unbound device → honest empty dashboard", async () => {
    const { db } = seedDb({ deviceOver: { device_uid: "UNBOUND", serial_number: "UNB2" } });
    const dash = await getDeviceOpsDashboard(db, device({ device_uid: "UNBOUND", serial_number: "UNB2" }) as unknown as SystemDeviceRow, new Date("2026-02-01T12:00:00Z"));
    expect(dash.unbound).toBe(true);
    expect(dash.commands.counts.total).toBe(0);
    expect(dash.hardware_events).toHaveLength(0);
    expect(dash.verification.heartbeat_received.state).toBe("yes"); // device row itself has a heartbeat
  });
});

/* ── Lib-level: requeueDeviceCommand direct ────────────────────────────── */

describe("requeueDeviceCommand (lib)", () => {
  it("reason <10 chars → 400 reason_required", async () => {
    const { db } = seedDb();
    const res = await requeueDeviceCommand(db, CMD_ID, {
      user: ACTOR as never, actor: { id: ACTOR.id, role: "sysadmin" }, reason: "too short",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("reason_required");
  });

  it("listCommandHistory rental filter matches payload rental_ref", async () => {
    const { db } = seedDb({
      commands: [cmd({ payload: { rental_ref: "ZR-ABC" } }), cmd({ id: CMD2_ID, kiosk_id: "kiosk-2", idempotency_key: "x2" })],
    });
    await db.from("rentals").insert({ id: "r-9", reference: "ZR-ABC", state: "active" });
    const res = await listCommandHistory(db, { rental: "ZR-ABC" });
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0].rental_ref).toBe("ZR-ABC");
  });
});
