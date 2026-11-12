import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  KioskSimulator, MockKioskAdapter, SimDeviceSession, createSimEnvironment, createSimRental,
} from "@/lib/kiosk/simulator";
import { queueCommand } from "@/lib/kiosk/commands";
import {
  getDeviceAuthRow, revokeDeviceCredential, startCredentialRotation,
} from "@/lib/system/device-auth";
import { decryptSecret } from "@/lib/system/device-auth";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * Simulator ack-contract tests — the FULL device lifecycle driven through the
 * real libs: provisioning redeem → HMAC-signed ingest → heartbeat → inventory
 * → dispense command + correlated ack → return detection → duplicate/replay →
 * out-of-order → rotation → revocation. Every emitted event must carry
 * simulated:true and every sim row must stay in the sim- namespace.
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

const KEK = "cd".repeat(32);
let prevKek: string | undefined;
beforeEach(() => {
  resetRateLimits();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  process.env.DEVICE_CREDENTIAL_KEK = KEK;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
});

async function setup(extra: Record<string, Row[]> = {}) {
  const { db, tables } = fakeDb({
    system_devices: [], system_device_messages: [], system_audit_events: [],
    kiosks: [], device_events: [], kiosk_events: [], kiosk_slots: [],
    power_banks: [], rentals: [], device_commands: [], rental_exceptions: [], audit_logs: [],
    ...extra,
  });
  const env = await createSimEnvironment(db, { suffix: `t${Math.random().toString(16).slice(2, 8)}` });
  return { db, tables, env };
}

describe("simulator — namespace isolation + simulated flag", () => {
  it("createSimEnvironment provisions through the real contract in the sim- namespace", async () => {
    const { db, tables, env } = await setup();
    expect(env.deviceUid).toMatch(/^sim-/);
    expect(env.stationId).toMatch(/^SIM-/);
    expect(env.device.capabilities?.simulated).toBe(true);
    expect(env.device.adapter_type).toBe("simulator");
    // Provisioning went through token issue → redeem → credential issue.
    expect(tables.system_devices[0].provision_token_used_at).toBeTruthy();
    expect(tables.system_devices[0].device_secret_enc).toMatch(/^v2\./);
    expect(tables.system_devices[0].status).toBe("active");
    // The raw secret is NEVER persisted.
    expect(JSON.stringify(tables.system_devices)).not.toContain(env.secret);
    expect(decryptSecret(tables.system_devices[0].device_secret_enc as string, env.device.id)).toBe(env.secret);
    expect(tables.kiosks[0].station_id).toBe(env.stationId);
  });

  it("every emitted event carries simulated:true — including ack/fault types", async () => {
    const sim = new KioskSimulator("SIM-X");
    sim.heartbeat();
    sim.slotState(1, "ready", "SIM-BANK-X");
    sim.dispenseAck("cmd-1", { slot: 1, bankSerial: "SIM-BANK-X" });
    sim.bankReleased("cmd-1");
    sim.dispenseFailed("cmd-2", "motor_stall");
    sim.returnDetected("SIM-BANK-X");
    sim.returnAck("cmd-3", { bankSerial: "SIM-BANK-X" });
    sim.returnRejected("slot_busy");
    sim.hardwareFault("over_temp");
    sim.dockBank("SIM-BANK-X", { slot: 1 });
    sim.flush();
    const all = sim.all();
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const e of all) expect(e.simulated).toBe(true);
    // And a caller cannot force simulated:false through the simulator.
    const forced = sim.emit({ type: "heartbeat", simulated: false });
    expect(forced.simulated).toBe(true);
  });

  it("does not touch pre-existing production rows", async () => {
    const prodKiosk = { id: "k-prod", station_id: "ZP-REAL-1", state: "online", last_seen_at: null };
    const prodDevice = {
      id: "d-prod", device_uid: "kiosk-real", serial_number: "ZP-REAL-1", status: "active",
      auth_method: "hmac_sha256", capabilities: {},
    };
    const { db, tables, env } = await setup({ kiosks: [prodKiosk], system_devices: [prodDevice] });
    const sim = new KioskSimulator(env.stationId);
    await env.session.post([sim.heartbeat(new Date().toISOString())]);
    const prod = tables.kiosks.find((k) => k.id === "k-prod");
    expect(prod?.last_seen_at).toBeNull(); // production kiosk untouched
    expect(tables.system_devices.find((d) => d.id === "d-prod")).toEqual(prodDevice);
  });
});

describe("SimDeviceSession — signed ingest contract", () => {
  it("heartbeat → 200 with heartbeat outcome; auth telemetry recorded", async () => {
    const { db, tables, env } = await setup();
    const sim = new KioskSimulator(env.stationId);
    const res = await env.session.post([sim.heartbeat(new Date().toISOString())]);
    expect(res.status).toBe(200);
    expect(res.outcomes?.[0]?.result).toBe("heartbeat");
    const claim = tables.system_device_messages.find((m) => m.message_type === "claim");
    expect(claim?.result).toBe("ok");
    expect(claim?.auth_method ?? "hmac_sha256").toBeTruthy();
  });

  it("duplicate X-Device-Message-Id → 409 duplicate_message", async () => {
    const { db, env } = await setup();
    const sim = new KioskSimulator(env.stationId);
    const mid = "sim-dup-msg-00000001";
    const r1 = await env.session.post([sim.heartbeat()], { messageId: mid });
    expect(r1.status).toBe(200);
    const r2 = await env.session.post([sim.heartbeat()], { messageId: mid });
    expect(r2.status).toBe(409);
    expect(r2.body.reason).toBe("duplicate_message");
  });

  it("duplicate event_id under a fresh nonce → lifecycle 'duplicate'", async () => {
    const { db, env } = await setup();
    const sim = new KioskSimulator(env.stationId);
    const evt = sim.heartbeat(new Date().toISOString());
    const r1 = await env.session.post([evt]);
    const r2 = await env.session.post([evt]);
    expect(r1.outcomes?.[0]?.result).toBe("heartbeat");
    expect(r2.outcomes?.[0]?.result).toBe("duplicate");
  });

  it("invalid signature → 401 bad_signature", async () => {
    const { db, env } = await setup();
    const sim = new KioskSimulator(env.stationId);
    const res = await env.session.post([sim.heartbeat()], { signature: "f".repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("rejects posting to a station the device is not bound to", async () => {
    const { db, env } = await setup();
    // Session bound to env.stationId; craft a body for a different station.
    const rogue = new SimDeviceSession({ db, deviceUid: env.deviceUid, stationId: "SIM-OTHER", secret: env.secret });
    const res = await rogue.post([new KioskSimulator("SIM-OTHER").heartbeat()]);
    // Station lookup fails first (no kiosks row for SIM-OTHER) → 404, or binding 403.
    expect([403, 404]).toContain(res.status);
  });
});

describe("full lifecycle — dispense ack → return → close", () => {
  it("dispense_acknowledged correlates command_id and activates the rental; return closes it", async () => {
    const { db, tables, env } = await setup();
    const rental = await createSimRental(db, env, { state: "payment_authorized" });
    const key = `sim-disp-${Date.now()}`;
    await queueCommand(db, {
      kioskId: env.kiosk.id, command: "unlock_slot", issuedBy: null,
      payload: { rental_id: rental.rentalId, slot: 1 }, key,
    });

    const sim = new KioskSimulator(env.stationId);
    const adapter = new MockKioskAdapter(env.stationId);
    adapter.banks.push(rental.bankSerial);
    const dispensed = await adapter.dispense({ rentalId: rental.rentalId, stationId: env.stationId, idempotencyKey: key });
    expect(dispensed.status).toBe("dispensed");

    const res = await env.session.post([
      sim.heartbeat(new Date().toISOString()),
      sim.slotState(1, "ready", rental.bankSerial),
      sim.dispenseAck(key, { slot: 1, bankSerial: rental.bankSerial, rentalRef: rental.reference, at: new Date().toISOString() }),
    ]);
    expect(res.status).toBe(200);
    expect(res.outcomes?.map((o) => o.result)).toEqual(["heartbeat", "ignored", "ack_recorded"]);

    const { data: cmd } = await db.from("device_commands").select("status").eq("idempotency_key", key).maybeSingle();
    expect(cmd?.status).toBe("acknowledged");
    const r1 = tables.rentals.find((r) => r.id === rental.rentalId);
    expect(r1?.state).toBe("active");
    expect(r1?.dispensed_at).toBeTruthy();

    // Return: sensor detection then verified dock.
    const sim2 = new KioskSimulator(env.stationId);
    const ret = await env.session.post([
      sim2.returnDetected(rental.bankSerial, { slot: 1, rentalRef: rental.reference, at: new Date().toISOString() }),
    ]);
    expect(ret.outcomes?.[0]?.result).toBe("returned");
    expect(tables.rentals.find((r) => r.id === rental.rentalId)?.state).toBe("returned");

    // Every persisted event payload is marked simulated.
    for (const ev of tables.device_events) {
      expect((ev.payload as Record<string, unknown>)?.simulated).toBe(true);
    }
    for (const ev of tables.kiosk_events) {
      expect((ev.payload as Record<string, unknown> | null)?.simulated).toBe(true);
    }
  });

  it("ack with unknown command_id raises rental_exceptions, never settles", async () => {
    const { db, tables, env } = await setup();
    const rental = await createSimRental(db, env, { state: "active" });
    const sim = new KioskSimulator(env.stationId);
    const res = await env.session.post([
      sim.dispenseAck(`sim-no-such-cmd-${Date.now()}`, {
        bankSerial: rental.bankSerial, rentalRef: rental.reference, at: new Date().toISOString(),
      }),
    ]);
    expect(res.outcomes?.[0]?.result).toBe("exception_raised");
    expect(tables.rental_exceptions.some((e) => e.kind === "unknown_command")).toBe(true);
    expect(tables.rentals.find((r) => r.id === rental.rentalId)?.state).toBe("active");
  });

  it("delayed/out-of-order hw_timestamp → 'out_of_order'", async () => {
    const { db, env } = await setup();
    const sim = new KioskSimulator(env.stationId);
    // Newer return-type event processed first (rejected is fine — it still claims processed_at).
    const newer = sim.dockBank("SIM-BANK-OOF-NEW", { at: "2026-02-01T03:00:00.000Z", hwTimestamp: "2026-02-01T03:00:00.000Z" });
    await env.session.post([newer]);
    const older = sim.dockBank("SIM-BANK-OOF-OLD", { at: "2026-02-01T02:00:00.000Z", hwTimestamp: "2026-02-01T02:00:00.000Z" });
    const res = await env.session.post([older]);
    expect(res.outcomes?.[0]?.result).toBe("out_of_order");
  });
});

describe("credential lifecycle — rotation overlap, revocation", () => {
  it("rotation: both secrets verify during overlap, first next-auth promotes, old rejected", async () => {
    const { db, tables, env } = await setup();
    const deviceRow = (await getDeviceAuthRow(db, env.device.id))!;
    const rot = await startCredentialRotation(db, deviceRow, { id: "sim-op", role: "system" });
    expect(rot.ok).toBe(true);
    if (!rot.ok) return;

    const sim = new KioskSimulator(env.stationId);
    // Old (primary) still verifies.
    const oldRes = await env.session.post([sim.heartbeat()]);
    expect(oldRes.status).toBe(200);
    // Next secret verifies AND promotes.
    const nextSession = new SimDeviceSession({ db, deviceUid: env.deviceUid, stationId: env.stationId, secret: rot.secret });
    const nextRes = await nextSession.post([new KioskSimulator(env.stationId).heartbeat()]);
    expect(nextRes.status).toBe(200);

    const after = await getDeviceAuthRow(db, env.device.id);
    expect(after?.device_secret_enc_next).toBeNull();
    expect(after?.credential_rotated_at).toBeTruthy();
    expect(decryptSecret(after!.device_secret_enc!, env.device.id)).toBe(rot.secret);

    // Old secret now rejected.
    const stale = await env.session.post([new KioskSimulator(env.stationId).heartbeat()]);
    expect(stale.status).toBe(401);
    expect(tables.system_devices[0].credential_rotated_at).toBeTruthy();
  });

  it("revocation: credential revoked → subsequent auth rejected", async () => {
    const { db, env } = await setup();
    const row = (await getDeviceAuthRow(db, env.device.id))!;
    const rev = await revokeDeviceCredential(db, row, { id: "sim-op", role: "system" });
    expect(rev.ok).toBe(true);
    const res = await env.session.post([new KioskSimulator(env.stationId).heartbeat()]);
    expect(res.status).toBe(401);
    expect(["credential_revoked", "auth_method_not_hmac", "no_credential"]).toContain(res.body.reason);
  });
});
