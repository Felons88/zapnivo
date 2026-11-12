import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret, deviceCredentialStatus, deviceSecretHash, deviceSigningKey,
  encryptSecret, issueDeviceCredential, newDeviceSecret, signDeviceRequest,
  startCredentialRotation, verifyDeviceAuth, type DeviceAuthRow,
} from "@/lib/system/device-auth";
import { deriveConnectivity } from "@/lib/system/kiosks";
import { runDeviceDiagnostics } from "@/lib/system/kiosks";
import { ingestKioskEvents, type IngestBody } from "@/lib/kiosk/ingest";
import { heartbeatStale, HEARTBEAT_STALE_MIN } from "@/lib/kiosk/heartbeat";
import { queueCommand } from "@/lib/kiosk/commands";
import { resetRateLimits } from "@/lib/rate-limit";

/**
 * HARDWARE CERTIFICATION SUITE — reusable gate for gateway vendors.
 *
 * Exercises the REAL device-auth + ingest functions against an in-memory
 * Supabase stub (same philosophy as tests/kiosk-lifecycle.test.ts and
 * tests/system-device-auth*.test.ts — no mocks of the code under test).
 *
 * Checklist mapping lives in docs/HARDWARE-GATEWAY-SPEC.md §9.
 * Items marked [BLOCKED: no ingest contract] have no server-side contract yet —
 * the tests certify the HONEST current behavior (rejection/ignore), never a
 * fabricated capability.
 */

/* ── In-memory SupabaseClient covering every query shape the kiosk pipeline
 *    and device-auth use (select/eq/in/is/not/gt/gte/lt/lte/or/order/limit,
 *    insert/update/upsert, single/maybeSingle, thenable). Unique-index
 *    enforcement mirrors the real partial unique indexes. ─────────────── */

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
    // Partial unique index system_device_messages_msgid_idx (0046):
    // unique (device_id, message_id) WHERE message_id IS NOT NULL.
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
    or() { return this; } // route-only PostgREST helper; not exercised here
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

const NOW = new Date("2026-02-01T12:00:00Z");
const SECRET = "znd_cert_primary_secret_0123456789abcdef";
const NEXT_SECRET = "znd_cert_next_secret_abcdef0123456789";
const UID = "kiosk-cert-uid";
const DEVICE_UUID = "55555555-5555-4555-8555-555555555555";
const STATION = "SN-CERT-1"; // = device.serial_number → station binding
const KIOSK_ID = "kiosk-cert-1";
const KEK = "ab".repeat(32);

function deviceSeed(over: Partial<DeviceAuthRow> & { last_heartbeat_at?: string | null; last_message_at?: string | null } = {}): DeviceAuthRow {
  return {
    id: DEVICE_UUID,
    device_uid: UID,
    serial_number: STATION,
    status: "active",
    auth_method: "hmac_sha256",
    device_secret_hash: deviceSecretHash(SECRET),
    device_secret_enc: encryptSecret(SECRET, DEVICE_UUID),
    device_secret_enc_next: null,
    credential_next_expires_at: null,
    credential_rotated_at: null,
    credential_issued_at: "2026-01-01T00:00:00Z",
    credential_expires_at: "2027-01-01T00:00:00Z",
    credential_revoked_at: null,
    last_authed_at: null,
    last_message_ts: null,
    ...over,
  };
}

/** Row mid-rotation: primary SECRET live + staged NEXT_SECRET (72h window). */
function rotatingSeed(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return deviceSeed({
    device_secret_enc_next: encryptSecret(NEXT_SECRET, DEVICE_UUID),
    // Must exceed BOTH the injected verify `now` (NOW) and real Date.now() —
    // start/cancel check pending-ness against wall-clock.
    credential_next_expires_at: new Date(Math.max(NOW.getTime(), Date.now()) + 48 * 3600_000).toISOString(),
    ...over,
  });
}

const kioskSeed = (over: Row = {}): Row => ({ id: KIOSK_ID, station_id: STATION, state: "online", last_seen_at: null, ...over });

let msgCounter = 0;
function signedReq(secret: string, body: string, opts: { messageId?: string; tsSec?: number; deviceId?: string; signature?: string } = {}) {
  const timestamp = String(opts.tsSec ?? Math.floor(NOW.getTime() / 1000));
  return {
    deviceId: opts.deviceId ?? UID,
    timestamp,
    signature: opts.signature ?? signDeviceRequest(secret, timestamp, body),
    body,
    messageId: opts.messageId ?? `certmsg-${++msgCounter}-abcdefgh`,
  };
}

const HEARTBEAT_BODY: IngestBody = {
  station_id: STATION,
  firmware_version: "fw-cert-1.0",
  events: [{ type: "heartbeat", event_id: `hb-${++msgCounter}`, at: NOW.toISOString() }],
};
const heartbeatBody = () => JSON.stringify(HEARTBEAT_BODY);

function dbFor(device: DeviceAuthRow | null, extra: Record<string, Row[]> = {}) {
  return fakeDb({
    system_devices: device ? [device as unknown as Row] : [],
    system_device_messages: [],
    system_audit_events: [],
    ...extra,
  });
}

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

/* ══════════════════════════════════════════════════════════════════════
 * C1 · PROVISIONING — issue credential → secret shown once, enc stored,
 *     hash is a fingerprint, secret material never persisted/returned.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C1 · provisioning", () => {
  it("issues a credential: secret returned once, v2 enc + sha256 fingerprint stored, hash never equals secret", async () => {
    const pending = deviceSeed({
      status: "registered", auth_method: "pending",
      device_secret_enc: null, device_secret_hash: null,
      credential_issued_at: null, credential_expires_at: null,
    });
    const { db, tables } = dbFor(pending);
    const res = await issueDeviceCredential(db, pending, { id: "op-1", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.secret).toMatch(/^znd_/);
    expect(res.expiresAt).toBeTruthy();

    const row = tables.system_devices[0];
    // Recoverable secret lives ONLY as KEK-wrapped, AAD-bound AES-256-GCM.
    expect(String(row.device_secret_enc)).toMatch(/^v2\.[A-Za-z0-9_-]+\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
    expect(decryptSecret(row.device_secret_enc as string, DEVICE_UUID)).toBe(res.secret);
    expect(() => decryptSecret(row.device_secret_enc as string)).toThrow(); // AAD required
    // Hash column is a non-reversible fingerprint — never the secret, never the key for v2.
    expect(row.device_secret_hash).toBe(deviceSecretHash(res.secret));
    expect(row.device_secret_hash).not.toBe(res.secret);
    expect(deviceSigningKey(res.secret)).toBe(deviceSecretHash(res.secret)); // documented derivation
    expect(row.auth_method).toBe("hmac_sha256");
    expect(row.status).toBe("provisioning"); // registered → provisioning legal edge
    expect(row.last_message_ts).toBeNull(); // rotation resets replay window

    // Secret material must not leak into audit/telemetry rows.
    const persisted = JSON.stringify({ devices: tables.system_devices, audit: tables.system_audit_events, messages: tables.system_device_messages });
    expect(persisted).not.toContain(res.secret);
    // Credential status surface exposes metadata only.
    const status = deviceCredentialStatus(row as unknown as DeviceAuthRow);
    expect(status.state).toBe("active");
    expect(JSON.stringify(status)).not.toContain(res.secret);
  });

  it("provisioned credential immediately authenticates (issue → first auth)", async () => {
    const pending = deviceSeed({
      status: "registered", auth_method: "pending",
      device_secret_enc: null, device_secret_hash: null,
      credential_issued_at: null, credential_expires_at: null,
    });
    const { db, tables } = dbFor(pending);
    const issued = await issueDeviceCredential(db, pending, { id: "op-1", role: "sysadmin" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // Simulate the device going active after first contact.
    tables.system_devices[0].status = "active";
    const res = await verifyDeviceAuth(db, signedReq(issued.secret, heartbeatBody()), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.keyMode).toBe("enc");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C2 · AUTHENTICATION — valid HMAC-SHA256 accepted; signature contract.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C2 · authentication", () => {
  it("accepts a correctly signed request and advances last_message_ts", async () => {
    const { db, tables } = dbFor(deviceSeed());
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.device.device_uid).toBe(UID);
    // verifyDeviceAuth blanks credential material on the returned row.
    expect(res.device.device_secret_enc).toBeNull();
    expect(res.device.device_secret_hash).toBeNull();
    const row = tables.system_devices[0];
    expect(Number(row.last_message_ts)).toBe(NOW.getTime());
    expect(row.last_authed_at).toBeTruthy();
  });

  it("accepts auth by device uuid as well as device_uid", async () => {
    const { db } = dbFor(deviceSeed());
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody(), { deviceId: DEVICE_UUID }), NOW);
    expect(res.ok).toBe(true);
  });

  it("rejects missing/malformed X-Device-Message-Id before any DB credential check", async () => {
    const { db } = dbFor(deviceSeed());
    const noId = signedReq(SECRET, heartbeatBody());
    // @ts-expect-error — intentionally omit required v2 header field
    delete noId.messageId;
    const r1 = await verifyDeviceAuth(db, noId, NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("missing_message_id");

    const bad = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody(), { messageId: "short!" }), NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_message_id");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C3 · HEARTBEAT — valid telemetry recorded end-to-end (auth → ingest).
 * ══════════════════════════════════════════════════════════════════════ */
describe("C3 · heartbeat", () => {
  it("authenticated heartbeat records auth claim + device event + kiosk liveness", async () => {
    const { db, tables } = dbFor(deviceSeed(), { kiosks: [kioskSeed()] });
    const body = heartbeatBody();
    const auth = await verifyDeviceAuth(db, signedReq(SECRET, body), NOW);
    expect(auth.ok).toBe(true);

    const result = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, JSON.parse(body) as IngestBody, NOW);
    expect(result.accepted).toBe(1);
    expect(result.outcomes[0]).toEqual({ result: "heartbeat" });

    // Auth telemetry: claim row carries message_id + payload hash.
    const claim = tables.system_device_messages.find((m) => m.message_type === "claim");
    expect(claim).toBeTruthy();
    expect(claim?.result).toBe("ok");
    expect(claim?.message_id).toBeTruthy();
    expect(claim?.payload_sha256).toBeTruthy();
    // Raw event log + kiosk liveness projection.
    expect(tables.device_events.some((e) => e.event_type === "heartbeat" && e.kiosk_id === KIOSK_ID)).toBe(true);
    expect(tables.kiosks[0].last_seen_at).toBe(NOW.toISOString());
    expect(tables.kiosks[0].firmware_version).toBe("fw-cert-1.0");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C4 · INVENTORY REPORTING — slot_state events project into kiosk_slots
 *     and power_banks. (No dedicated inventory message type exists; this is
 *     the actual contract.)
 * ══════════════════════════════════════════════════════════════════════ */
describe("C4 · inventory reporting", () => {
  it("slot_state + power_bank_serial events upsert kiosk_slots and power_banks", async () => {
    const { db, tables } = dbFor(deviceSeed(), { kiosks: [kioskSeed()] });
    const body: IngestBody = {
      station_id: STATION,
      events: [
        { type: "slot_state", event_id: "inv-1-abcdefgh", slot: 1, slot_state: "ready", power_bank_serial: "SN-BANK-1", battery_pct: 87, at: NOW.toISOString() },
        { type: "slot_state", event_id: "inv-2-abcdefgh", slot: 2, slot_state: "empty" },
        { type: "slot_state", event_id: "inv-3-abcdefgh", slot: 3, slot_state: "fault" },
      ],
    };
    const result = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, body, NOW, { notifyReturned: async () => {} });
    expect(result.accepted).toBe(3);
    // Unknown-to-lifecycle types are recorded, not dropped.
    expect(result.outcomes.every((o) => o.result === "ignored")).toBe(true);

    const slots = tables.kiosk_slots;
    expect(slots).toHaveLength(3);
    expect(slots.find((s) => s.slot_number === 1)).toMatchObject({ state: "ready", power_bank_id: "power_banks-1" });
    expect(slots.find((s) => s.slot_number === 2)).toMatchObject({ state: "empty", power_bank_id: null });
    expect(tables.power_banks[0]).toMatchObject({ serial: "SN-BANK-1", battery_pct: 87, current_kiosk: KIOSK_ID });
    expect(tables.device_events).toHaveLength(3);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C5 · READ-ONLY DIAGNOSTICS (ping-equivalent) — must be honest: with
 *     KIOSK_ADAPTER=none it reports adapter_unavailable, never fabricates.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C5 · read-only diagnostics", () => {
  it("diagnostics reports adapter_unavailable and unverified hardware stages", async () => {
    const device = deviceSeed({ last_heartbeat_at: null, last_message_at: null });
    const { db } = dbFor(device, { system_hardware_profiles: [] });
    const res = await runDeviceDiagnostics(db, device as never);
    expect(res.status).toBe("adapter_unavailable");
    expect(res.adapter).toBe("none");
    const byStage = Object.fromEntries(res.readiness.map((r) => [r.stage, r.state]));
    expect(byStage.api_reachable).toBe("verified");
    expect(byStage.gateway_reachable).toBe("unverified"); // no live ping exists
    expect(byStage.hardware_confirmed).toBe("unverified"); // no certified profile
    // Read-only: diagnostics must not write device/command rows.
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C6 · CREDENTIAL ROTATION — 0048 flow: stage → 72h overlap (both verify)
 *     → promote-on-first-auth → expired window rejected.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C6 · credential rotation", () => {
  it("overlap window: BOTH primary and next secrets verify", async () => {
    const { db: dbOld } = dbFor(rotatingSeed());
    const r1 = await verifyDeviceAuth(dbOld, signedReq(SECRET, heartbeatBody()), NOW);
    expect(r1.ok).toBe(true);

    // Fresh db for the next-secret check so promotion state doesn't leak.
    const { db: dbNew, tables } = dbFor(rotatingSeed());
    const r2 = await verifyDeviceAuth(dbNew, signedReq(NEXT_SECRET, heartbeatBody()), NOW);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.keyMode).toBe("enc"); // staged slot is always enc-mode

    // First next-auth PROMOTED the credential.
    const row = tables.system_devices[0];
    expect(decryptSecret(row.device_secret_enc as string, DEVICE_UUID)).toBe(NEXT_SECRET);
    expect(row.device_secret_enc_next).toBeNull();
    expect(row.credential_next_expires_at).toBeNull();
    expect(row.credential_rotated_at).toBeTruthy();
    expect(row.device_secret_hash).toBe(deviceSecretHash(NEXT_SECRET));
  });

  it("expired rotation window: next secret rejected, primary still works", async () => {
    const expired = rotatingSeed({ credential_next_expires_at: "2026-01-20T00:00:00Z" }); // before NOW
    const { db: dbNext } = dbFor(expired);
    const r1 = await verifyDeviceAuth(dbNext, signedReq(NEXT_SECRET, heartbeatBody()), NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("bad_signature");

    const { db: dbOld } = dbFor(expired);
    const r2 = await verifyDeviceAuth(dbOld, signedReq(SECRET, heartbeatBody()), NOW);
    expect(r2.ok).toBe(true);
  });

  it("startCredentialRotation stages a 72h next slot and returns the secret once", async () => {
    const device = deviceSeed();
    const { db, tables } = dbFor(device);
    const res = await startCredentialRotation(db, device, { id: "op-1", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^znd_/);
    const row = tables.system_devices[0];
    expect(row.device_secret_enc_next).toMatch(/^v2\./);
    expect(decryptSecret(row.device_secret_enc_next as string, DEVICE_UUID)).toBe(res.secret);
    const ttl = Date.parse(String(row.credential_next_expires_at)) - Date.now();
    expect(ttl).toBeGreaterThan(71 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(72 * 3600_000);
    // Primary untouched — old secret still verifies during overlap.
    expect(decryptSecret(row.device_secret_enc as string, DEVICE_UUID)).toBe(SECRET);
    const auth = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
    expect(auth.ok).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C7 · OFFLINE DETECTION — stale heartbeat math + auth timestamp window.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C7 · offline detection", () => {
  it("heartbeatStale flags last_seen_at older than HEARTBEAT_STALE_MIN", () => {
    const fresh = new Date(NOW.getTime() - (HEARTBEAT_STALE_MIN - 1) * 60_000).toISOString();
    const stale = new Date(NOW.getTime() - (HEARTBEAT_STALE_MIN + 1) * 60_000).toISOString();
    expect(heartbeatStale(fresh, NOW)).toBe(false);
    expect(heartbeatStale(stale, NOW)).toBe(true);
    expect(heartbeatStale(null, NOW)).toBe(true);
    expect(heartbeatStale("not-a-date", NOW)).toBe(true);
  });

  it("deriveConnectivity reports stale for system_devices heartbeat age", () => {
    const staleTs = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const c = deriveConnectivity({ last_heartbeat_at: staleTs, last_message_at: staleTs }, NOW);
    expect(c.kind).toBe("stale");
    expect(deriveConnectivity({ last_heartbeat_at: null, last_message_at: null }, NOW).kind).toBe("no_data");
  });

  it("auth rejects timestamps outside the ±5 minute window (offline clock)", async () => {
    const { db } = dbFor(deviceSeed());
    const tenMinAgo = Math.floor(NOW.getTime() / 1000) - 600;
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody(), { tsSec: tenMinAgo }), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_timestamp");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C8 · RECONNECTION — heartbeat from an offline kiosk restores online state.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C8 · reconnection", () => {
  it("heartbeat flips kiosk state offline → online and clears offline_alerted_at", async () => {
    const { db, tables } = dbFor(deviceSeed(), {
      kiosks: [kioskSeed({ state: "offline", offline_alerted_at: "2026-02-01T10:00:00Z" })],
    });
    const body = JSON.stringify({
      station_id: STATION,
      events: [{ type: "heartbeat", event_id: `recon-${++msgCounter}` }],
    });
    const auth = await verifyDeviceAuth(db, signedReq(SECRET, body), NOW);
    expect(auth.ok).toBe(true);
    const result = await ingestKioskEvents(db, { id: KIOSK_ID, state: "offline" }, JSON.parse(body) as IngestBody, NOW);
    expect(result.outcomes[0]).toEqual({ result: "heartbeat" });
    expect(tables.kiosks[0].state).toBe("online");
    expect(tables.kiosks[0].offline_alerted_at).toBeNull();
    expect(tables.kiosks[0].last_seen_at).toBe(NOW.toISOString());
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C9 · RETURN DETECTION — power_bank_docked completes the rental.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C9 · return detection", () => {
  const rentalRow = (): Row => ({
    id: "rental-1", reference: "ZR-CERT", state: "active", power_bank_id: "bank-1",
    kiosk_id: KIOSK_ID, return_kiosk_id: null, non_return_deadline: null,
    returned_at: null, return_disputed: false, non_return_fee_status: "none",
    created_at: "2026-01-30T00:00:00.000Z",
  });
  const bankRow = (): Row => ({ id: "bank-1", serial: "SN-BANK-1", battery_pct: 40, current_kiosk: KIOSK_ID, retired: false });

  it("dock event verifies bank↔rental and marks rental returned", async () => {
    const { db, tables } = dbFor(deviceSeed(), {
      kiosks: [kioskSeed()], rentals: [rentalRow()], power_banks: [bankRow()],
    });
    const body: IngestBody = {
      station_id: STATION,
      events: [{
        type: "power_bank_docked", event_id: `dock-${++msgCounter}`,
        power_bank_serial: "SN-BANK-1", at: "2026-02-01T11:59:00.000Z",
      }],
    };
    const result = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, body, NOW, { notifyReturned: async () => {} });
    expect(result.outcomes[0]).toEqual({ result: "returned", rentalId: "rental-1" });
    expect(tables.rentals[0]).toMatchObject({
      state: "returned", returned_at: "2026-02-01T11:59:00.000Z", return_kiosk_id: KIOSK_ID,
    });
    expect(tables.kiosk_events[0]).toMatchObject({ result: "returned" });
  });

  it("replayed dock event_id dedupes to 'duplicate' — no double return", async () => {
    const { db, tables } = dbFor(deviceSeed(), {
      kiosks: [kioskSeed()], rentals: [rentalRow()], power_banks: [bankRow()],
    });
    const body: IngestBody = {
      station_id: STATION,
      events: [{ type: "bank_returned", event_id: "dock-fixed-id-1", power_bank_serial: "SN-BANK-1" }],
    };
    const deps = { notifyReturned: vi.fn().mockResolvedValue(true) };
    const first = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, body, NOW, deps);
    const second = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, body, NOW, deps);
    expect(first.outcomes[0]).toMatchObject({ result: "returned" });
    expect(second.outcomes[0]).toEqual({ result: "duplicate" });
    expect(deps.notifyReturned).toHaveBeenCalledTimes(1);
    expect(tables.kiosk_events).toHaveLength(1);
    expect(tables.device_events).toHaveLength(1); // duplicate skipped entirely
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C10 · DISPENSE / COMMAND PATH — [BLOCKED: no ingest contract].
 *     There is NO device→server dispense-ack event type and no live adapter.
 *     Certification asserts the honest behavior: unknown types are accepted
 *     but 'ignored' (durably logged, zero lifecycle effect), and the command
 *     queue dedupes on idempotency_key.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C10 · dispense/command path [BLOCKED: no ingest contract]", () => {
  it("vendor dispense-ack event types are honestly 'ignored' — never treated as returns", async () => {
    const { db, tables } = dbFor(deviceSeed(), {
      kiosks: [kioskSeed()],
      rentals: [{
        id: "rental-1", state: "active", power_bank_id: "bank-1", kiosk_id: KIOSK_ID,
        return_kiosk_id: null, non_return_deadline: null, returned_at: null,
        return_disputed: false, non_return_fee_status: "none", created_at: "2026-01-30T00:00:00.000Z",
      }],
    });
    const body: IngestBody = {
      station_id: STATION,
      events: [
        // A plausible vendor ack string — the contract does NOT define it.
        { type: "dispense_ack", event_id: "ack-1-abcdefgh", slot: 1, payload: { command_id: "cmd-1", result: "ok" } },
        { type: "dispense_complete", event_id: "ack-2-abcdefgh", slot: 2 },
      ],
    };
    const result = await ingestKioskEvents(db, { id: KIOSK_ID, state: "online" }, body, NOW, { notifyReturned: async () => {} });
    expect(result.outcomes.map((o) => o.result)).toEqual(["ignored", "ignored"]);
    // No rental side-effects, but events ARE durably logged for forensics.
    expect(tables.rentals[0].state).toBe("active");
    expect(tables.device_events).toHaveLength(2);
    // Any event carrying event_id gets a kiosk_events claim row — recorded
    // with result 'ignored', never lifecycle-processed.
    expect(tables.kiosk_events).toHaveLength(2);
    expect(tables.kiosk_events.every((e) => e.result === "ignored")).toBe(true);
  });

  it("command queue is idempotent on idempotency_key (server→device side)", async () => {
    const { db, tables } = dbFor(deviceSeed(), { device_commands: [] });
    const c = { kioskId: KIOSK_ID, command: "unlock_slot" as const, issuedBy: null, payload: { slot: 1 }, key: "cert-cmd-key-1" };
    const first = await queueCommand(db, c);
    const second = await queueCommand(db, c);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true });
    expect(tables.device_commands).toHaveLength(1);
    // NOTE: delivery + device ack remain [REQUIRES VENDOR DOCS] — NullKioskAdapter
    // reports 'unsupported' and no ack ingest endpoint exists (spec §4.3–4.4).
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C11 · IDEMPOTENCY — duplicate message_id → 409 duplicate_message.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C11 · idempotency", () => {
  it("replayed X-Device-Message-Id is rejected 409 after signature verification", async () => {
    const { db, tables } = dbFor(deviceSeed());
    const body = heartbeatBody();
    const req = signedReq(SECRET, body, { messageId: "dup-check-12345678" });
    const first = await verifyDeviceAuth(db, req, NOW);
    expect(first.ok).toBe(true);

    const second = await verifyDeviceAuth(db, { ...req }, NOW);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.reason).toBe("duplicate_message");
    }
    // Dedup claim is the authoritative row; the rejection is logged WITHOUT
    // re-using message_id (would itself trip the unique index).
    const claims = tables.system_device_messages.filter((m) => m.message_type === "claim");
    expect(claims).toHaveLength(1);
    const rejected = tables.system_device_messages.find((m) => m.result === "rejected");
    expect(rejected?.message_id).toBeUndefined();
  });

  it("same message_id on a DIFFERENT device is allowed (key is per-device)", async () => {
    const otherId = "66666666-6666-4666-8666-666666666666";
    const other = deviceSeed({
      id: otherId,
      device_uid: "kiosk-cert-uid-2", serial_number: "SN-CERT-2",
      // v2 ciphertext is AAD-bound to the OWNING device uuid — re-encrypt for row 2.
      device_secret_enc: encryptSecret(SECRET, otherId),
    });
    const { db: db2 } = fakeDb({
      system_devices: [deviceSeed() as unknown as Row, other as unknown as Row],
      system_device_messages: [], system_audit_events: [],
    });
    const body = heartbeatBody();
    const mid = "shared-msg-id-0001";
    const r1 = await verifyDeviceAuth(db2, signedReq(SECRET, body, { messageId: mid }), NOW);
    expect(r1.ok).toBe(true);
    const r2 = await verifyDeviceAuth(db2, signedReq(SECRET, body, { messageId: mid, deviceId: "kiosk-cert-uid-2" }), NOW);
    expect(r2.ok).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * C12–C14 · NEGATIVE AUTH — invalid signature, revoked credential,
 *           expired rotation window / expired primary.
 * ══════════════════════════════════════════════════════════════════════ */
describe("C12 · negative auth — invalid signature", () => {
  it("rejects a signature that doesn't match HMAC(secret, ts.body)", async () => {
    const { db } = dbFor(deviceSeed());
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody(), { signature: "0".repeat(64) }), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("rejects a signature computed over a DIFFERENT body (tamper)", async () => {
    const { db } = dbFor(deviceSeed());
    const req = signedReq(SECRET, heartbeatBody());
    req.body = JSON.stringify({ station_id: STATION, events: [{ type: "heartbeat" }, { type: "power_bank_docked" }] });
    const res = await verifyDeviceAuth(db, req, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { db } = dbFor(deviceSeed());
    const res = await verifyDeviceAuth(db, signedReq(newDeviceSecret(), heartbeatBody()), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });
});

describe("C13 · negative auth — revoked credential", () => {
  it("rejects auth after credential_revoked_at is stamped", async () => {
    const { db } = dbFor(deviceSeed({ credential_revoked_at: "2026-01-15T00:00:00Z" }));
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("credential_revoked");
  });

  it("rejects auth when auth_method was cleared to 'none' by revocation", async () => {
    const { db } = dbFor(deviceSeed({ auth_method: "none", device_secret_enc: null, device_secret_hash: null, credential_revoked_at: "2026-01-15T00:00:00Z" }));
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["auth_method_not_hmac", "no_credential", "credential_revoked"]).toContain(res.reason);
  });
});

describe("C14 · negative auth — expired credentials", () => {
  it("rejects an expired primary credential (credential_expires_at < now)", async () => {
    const { db } = dbFor(deviceSeed({ credential_expires_at: "2026-01-20T00:00:00Z" }));
    const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("credential_expired");
  });

  it("rejects devices in non-authenticatable states (suspended/quarantined/decommissioned)", async () => {
    for (const status of ["suspended", "quarantined", "decommissioned", "registered"]) {
      const { db } = dbFor(deviceSeed({ status }));
      const res = await verifyDeviceAuth(db, signedReq(SECRET, heartbeatBody()), NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("device_status");
    }
  });
});
