import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/* Route-level mocks (hoisted) — the lib functions below take `db` explicitly
 * and are unaffected; these only serve the /api/system route handler tests. */
const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  devAuth: () => false,
  isStaff: (u: { role?: string } | null) => u?.role === "admin",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import {
  cancelCredentialRotation, decryptSecret, deviceCredentialStatus, deviceSecretHash, encryptSecret,
  reencryptDeviceCredential, revokeDeviceCredential, rotationWindowMs,
  signDeviceRequest, startCredentialRotation, sweepExpiredRotations, verifyDeviceAuth,
  type DeviceAuthRow,
} from "@/lib/system/device-auth";
import { securityReadiness } from "@/lib/system/readiness";
import { resetRateLimits } from "@/lib/rate-limit";
import { POST as rotatePOST } from "@/app/api/system/kiosks/[id]/credential/rotate/route";
import { POST as cancelPOST } from "@/app/api/system/kiosks/[id]/credential/rotate/cancel/route";
import { POST as reencryptPOST } from "@/app/api/system/kiosks/[id]/credential/reencrypt/route";

/* ── Minimal Supabase stub — extends the hardening-test pattern with an
 *    `_updates` array so promotion/rotation patches can be inspected. ──── */

type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _updates?: unknown[]; _inserts?: unknown[]; _calls?: unknown[][] } = { _updates: [], _inserts: [], _calls: [] };
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter", "gt", "lt", "gte", "lte", "ilike", "like"]) {
    b[m] = (...a: unknown[]) => {
      (b._calls as unknown[][]).push([m, ...a]);
      if (m === "insert") { b._insert = a[0]; (b._inserts as unknown[]).push(a[0]); }
      if (m === "update") { b._update = a[0]; (b._updates as unknown[]).push(a[0]); }
      return b;
    };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null, count: 0 }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}

const NOW = new Date("2026-02-01T12:00:00Z");
const SECRET = "znd_rotation_primary_secret_0123456789";
const NEXT_SECRET = "znd_rotation_next_secret_abcdef0123456789";
const UID = "kiosk-rotation-uid";
const DEVICE_UUID = "33333333-3333-4333-8333-333333333333";
const OTHER_UUID = "44444444-4444-4444-8444-444444444444";
const KEK_A = "11".repeat(32);
const KEK_B = "22".repeat(32);
const KEK_C = "33".repeat(32);
const BODY = JSON.stringify({ station_id: "SN-ROT-1", events: [{ type: "heartbeat" }] });

function deviceRow(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return {
    id: DEVICE_UUID,
    device_uid: UID,
    serial_number: "SN-ROT-1",
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
function rotatingRow(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return deviceRow({
    device_secret_enc_next: encryptSecret(NEXT_SECRET, DEVICE_UUID),
    // Future relative to BOTH the injected verify `now` (NOW) and real time —
    // start/cancel check pending-ness against Date.now().
    credential_next_expires_at: new Date(Math.max(NOW.getTime(), Date.now()) + 48 * 3600_000).toISOString(),
    ...over,
  });
}

let msgCounter = 0;
function signedReq(secret: string, body = BODY, messageId?: string) {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  return {
    deviceId: UID, timestamp,
    signature: signDeviceRequest(secret, timestamp, body),
    body,
    messageId: messageId ?? `rotmsg-${++msgCounter}-abcdefgh`,
  };
}

function dbFor(device: DeviceAuthRow | null, extraSingles: Result[] = [], tables: Record<string, ReturnType<typeof fakeTable>> = {}) {
  const devices = fakeTable({ singles: [{ data: device, error: null }, ...extraSingles] });
  const messages = fakeTable();
  const audit = fakeTable();
  const db = fakeDb({ system_devices: devices, system_device_messages: messages, system_audit_events: audit, ...tables });
  return { db, devices, messages, audit };
}

let prevKek: string | undefined;
let prevKekPrev: string | undefined;
let prevWinHours: string | undefined;
beforeEach(() => {
  resetRateLimits();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  prevKekPrev = process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
  prevWinHours = process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS;
  process.env.DEVICE_CREDENTIAL_KEK = KEK_A;
  delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
  delete process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
  if (prevKekPrev === undefined) delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
  else process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = prevKekPrev;
  if (prevWinHours === undefined) delete process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS;
  else process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = prevWinHours;
});

/* ── v2 AAD binding ─────────────────────────────────────────────────────── */

describe("v2 AAD binding — ciphertext is row-bound", () => {
  it("encrypt under device A, store on device B → auth FAILS", async () => {
    // The classic swap attack: enc made for OTHER_UUID pasted onto DEVICE_UUID's row.
    const swapped = deviceRow({ device_secret_enc: encryptSecret(SECRET, OTHER_UUID) });
    const { db } = dbFor(swapped);
    const res = await verifyDeviceAuth(db, signedReq(SECRET), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_decrypt_failed"); // GCM tag fails on AAD mismatch
  });

  it("direct decrypt with the wrong AAD throws", () => {
    const enc = encryptSecret(SECRET, DEVICE_UUID);
    expect(decryptSecret(enc, DEVICE_UUID)).toBe(SECRET);
    expect(() => decryptSecret(enc, OTHER_UUID)).toThrow();
    expect(() => decryptSecret(enc)).toThrow();
  });
});

/* ── KEK candidates at verify time ──────────────────────────────────────── */

describe("verifyDeviceAuth — KEK rotation fallback", () => {
  it("wrong current KEK + matching PREVIOUS still verifies", async () => {
    const { db, messages } = dbFor(deviceRow());
    process.env.DEVICE_CREDENTIAL_KEK = KEK_B; // ciphertext was made under KEK_A
    process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = KEK_A;
    const res = await verifyDeviceAuth(db, signedReq(SECRET), NOW);
    expect(res.ok).toBe(true);
    const claim = ((messages._inserts ?? []) as Record<string, unknown>[]).find((r) => r.message_type === "claim");
    expect((claim?.detail as Record<string, unknown>)?.key_version).toBe("k1"); // label only, never key material
  });

  it("no matching KEK at all fails closed (503)", async () => {
    const { db } = dbFor(deviceRow());
    process.env.DEVICE_CREDENTIAL_KEK = KEK_C;
    process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = KEK_B;
    const res = await verifyDeviceAuth(db, signedReq(SECRET), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_decrypt_failed");
  });

  it("legacy v1 ciphertext still verifies and reports key_version=v1", async () => {
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEK_A, "hex"), iv);
    const ct = Buffer.concat([cipher.update(SECRET, "utf8"), cipher.final()]);
    const v1 = `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
    const { db, messages } = dbFor(deviceRow({ device_secret_enc: v1 }));
    const res = await verifyDeviceAuth(db, signedReq(SECRET), NOW);
    expect(res.ok).toBe(true);
    const claim = ((messages._inserts ?? []) as Record<string, unknown>[]).find((r) => r.message_type === "claim");
    expect((claim?.detail as Record<string, unknown>)?.key_version).toBe("v1");
  });
});

/* ── Zero-downtime rotation ─────────────────────────────────────────────── */

describe("zero-downtime credential rotation", () => {
  it("startCredentialRotation stages a v2 next secret (72h) and keeps primary valid", async () => {
    const device = deviceRow();
    const devices = fakeTable({ singles: [{ data: device, error: null }, { data: { ...device, device_secret_enc_next: "x" }, error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await startCredentialRotation(db, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^znd_/);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_enc_next).toMatch(/^v2\.k1\./);
    expect(decryptSecret(patch.device_secret_enc_next as string, DEVICE_UUID)).toBe(res.secret);
    const ttl = Date.parse(String(patch.credential_next_expires_at)) - Date.now();
    expect(ttl).toBeGreaterThan(71 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(72 * 3600_000);
    expect(patch.device_secret_enc).toBeUndefined(); // primary untouched
    expect((audit._inserts ?? []) as Record<string, unknown>[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "kiosk.credential_rotation_started" })]),
    );
  });

  it("startCredentialRotation refuses when a rotation is already pending", async () => {
    const device = rotatingRow();
    const db = fakeDb({ system_devices: fakeTable() });
    const res = await startCredentialRotation(db, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("overlap window: BOTH old and new secrets verify", async () => {
    const { db: dbOld } = dbFor(rotatingRow());
    const r1 = await verifyDeviceAuth(dbOld, signedReq(SECRET), NOW);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.keyMode).toBe("enc");

    const { db: dbNew } = dbFor(rotatingRow());
    const r2 = await verifyDeviceAuth(dbNew, signedReq(NEXT_SECRET), NOW);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.keyMode).toBe("enc");
  });

  it("primary auth during rotation does NOT promote (no enc fields patched)", async () => {
    const { db, devices } = dbFor(rotatingRow());
    await verifyDeviceAuth(db, signedReq(SECRET), NOW);
    const updates = (devices._updates ?? []) as Record<string, unknown>[];
    // Only the last_message_ts heartbeat update — never a credential write.
    expect(updates.every((u) => u.device_secret_enc === undefined && u.device_secret_enc_next === undefined)).toBe(true);
  });

  it("first auth with the next secret PROMOTES it to primary + audits", async () => {
    const row = rotatingRow();
    const nextEnc = row.device_secret_enc_next as string;
    // singles: findDevice row, then promote's maybeSingle({id}), then…
    const { db, devices, messages, audit } = dbFor(row, [{ data: { id: DEVICE_UUID }, error: null }]);
    const res = await verifyDeviceAuth(db, signedReq(NEXT_SECRET), NOW);
    expect(res.ok).toBe(true);

    const promotion = ((devices._updates ?? []) as Record<string, unknown>[]).find((u) => u.device_secret_enc === nextEnc);
    expect(promotion).toBeTruthy();
    expect(promotion?.device_secret_enc_next).toBeNull();
    expect(promotion?.credential_next_expires_at).toBeNull();
    expect(promotion?.credential_rotated_at).toBeTruthy();
    expect(promotion?.device_secret_hash).toBe(deviceSecretHash(NEXT_SECRET));
    expect((audit._inserts ?? []) as Record<string, unknown>[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "kiosk.credential_rotation_completed" })]),
    );
    // Telemetry marks the promotion — still no secret material.
    const telemetry = [
      ...((devices._inserts ?? []) as unknown[]),
      ...((messages._inserts ?? []) as unknown[]),
      ...((audit._inserts ?? []) as unknown[]),
    ].map((r) => JSON.stringify(r)).join("\n");
    expect(telemetry).not.toContain(NEXT_SECRET);
    expect(telemetry).not.toContain(SECRET);
  });

  it("expired next slot is rejected — old secret still works", async () => {
    const expired = rotatingRow({ credential_next_expires_at: "2026-01-20T00:00:00Z" }); // before NOW
    const { db: dbNext } = dbFor(expired);
    const r1 = await verifyDeviceAuth(dbNext, signedReq(NEXT_SECRET), NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("bad_signature");

    const { db: dbOld } = dbFor(expired);
    const r2 = await verifyDeviceAuth(dbOld, signedReq(SECRET), NOW);
    expect(r2.ok).toBe(true);
  });

  it("cancelCredentialRotation clears the next slot and audits", async () => {
    const device = rotatingRow();
    const devices = fakeTable({ singles: [{ data: { ...device, device_secret_enc_next: null }, error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await cancelCredentialRotation(db, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_enc_next).toBeNull();
    expect(patch.credential_next_expires_at).toBeNull();
    expect((audit._inserts ?? []) as Record<string, unknown>[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "kiosk.credential_rotation_cancelled" })]),
    );
  });

  it("cancelCredentialRotation 409s when nothing is pending", async () => {
    const db = fakeDb({ system_devices: fakeTable() });
    const res = await cancelCredentialRotation(db, deviceRow(), { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("revokeDeviceCredential clears BOTH slots", async () => {
    const device = rotatingRow();
    const devices = fakeTable({ singles: [{ data: deviceRow({ auth_method: "none" }), error: null }] });
    const db = fakeDb({ system_devices: devices });
    const res = await revokeDeviceCredential(db, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_enc).toBeNull();
    expect(patch.device_secret_enc_next).toBeNull();
    expect(patch.credential_next_expires_at).toBeNull();
  });
});

/* ── KEK re-encryption ──────────────────────────────────────────────────── */

describe("reencryptDeviceCredential (KEK rotation step)", () => {
  it("decrypts under PREVIOUS, re-encrypts under current, verifies before write", async () => {
    const oldEnc = encryptSecret(SECRET, DEVICE_UUID); // under KEK_A
    const device = deviceRow({ device_secret_enc: oldEnc });
    const devices = fakeTable({ singles: [{ data: device, error: null }, { data: device, error: null }] });
    const db = fakeDb({ system_devices: devices, system_audit_events: fakeTable() });
    process.env.DEVICE_CREDENTIAL_KEK = KEK_B;
    process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = KEK_A;

    const res = await reencryptDeviceCredential(db, DEVICE_UUID, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const newEnc = (devices._update as Record<string, unknown>).device_secret_enc as string;
    expect(newEnc).toMatch(/^v2\.k1\./);
    expect(newEnc).not.toBe(oldEnc);
    // Prove it is bound to the CURRENT KEK only: with PREVIOUS unset the new
    // ciphertext still decrypts; the OLD one no longer does.
    delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
    expect(decryptSecret(newEnc, DEVICE_UUID)).toBe(SECRET);
    expect(() => decryptSecret(oldEnc, DEVICE_UUID)).toThrow();
  });

  it("fails closed (503) and writes NOTHING when no candidate KEK decrypts", async () => {
    const device = deviceRow(); // enc under KEK_A
    const devices = fakeTable({ singles: [{ data: device, error: null }] });
    const db = fakeDb({ system_devices: devices });
    process.env.DEVICE_CREDENTIAL_KEK = KEK_C;
    process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = KEK_B;
    const res = await reencryptDeviceCredential(db, DEVICE_UUID, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
    expect(devices._update).toBeUndefined(); // verify-before-write: nothing persisted
  });

  it("409s when the device has no encrypted credential", async () => {
    const device = deviceRow({ device_secret_enc: null });
    const devices = fakeTable({ singles: [{ data: device, error: null }] });
    const db = fakeDb({ system_devices: devices });
    const res = await reencryptDeviceCredential(db, DEVICE_UUID, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

/* ── Route-level: elevation gate ────────────────────────────────────────── */

const ROUTE_PARAMS = { params: Promise.resolve({ id: DEVICE_UUID }) };
const SESSION_USER = { id: "op-1", email: "op@zapnivo.com", role: "staff", organizationId: null };

function routeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return fakeDb({
    profiles: fakeTable({ singles: [{ data: { system_role: "sysadmin", system_suspended: false }, error: null }] }),
    ...tables,
  });
}

describe("credential mutation routes — step-up elevation required", () => {
  it("rotate returns 403 step_up_required without a live elevation", async () => {
    session.mockResolvedValue(SESSION_USER);
    service.mockReturnValue(routeDb({ system_elevations: fakeTable({ list: { data: [], error: null } }) }));
    const res = await rotatePOST(new Request("http://x", { method: "POST" }), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe("step_up_required");
  });

  it("rotate/cancel returns 403 step_up_required without a live elevation", async () => {
    session.mockResolvedValue(SESSION_USER);
    service.mockReturnValue(routeDb({ system_elevations: fakeTable({ list: { data: [], error: null } }) }));
    const res = await cancelPOST(new Request("http://x", { method: "POST" }), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
  });

  it("reencrypt returns 403 step_up_required without a live elevation", async () => {
    session.mockResolvedValue(SESSION_USER);
    service.mockReturnValue(routeDb({ system_elevations: fakeTable({ list: { data: [], error: null } }) }));
    const res = await reencryptPOST(new Request("http://x", { method: "POST" }), ROUTE_PARAMS);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("step_up_required");
  });

  it("rotate succeeds with a live elevation and returns the secret once", async () => {
    session.mockResolvedValue(SESSION_USER);
    const elev = {
      id: "e1", profile_id: "op-1", method: "totp",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      consumed_action: null, created_ip: null,
    };
    const device = deviceRow();
    const db = routeDb({
      system_elevations: fakeTable({ list: { data: [elev], error: null } }),
      system_devices: fakeTable({ singles: [{ data: device, error: null }, { data: device, error: null }] }),
      system_audit_events: fakeTable(),
    });
    service.mockReturnValue(db);
    const res = await rotatePOST(new Request("http://x", { method: "POST" }), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.secret).toMatch(/^znd_/);
    expect(j.next_expires_at).toBeTruthy();
  });
});

/* ── Readiness aggregate ────────────────────────────────────────────────── */

describe("securityReadiness", () => {
  it("returns real counts shape with no credential material", async () => {
    const countDb = (count: number) => fakeTable({ list: { data: [], error: null, count } });
    const db = fakeDb({
      system_devices: countDb(3),
      system_device_messages: countDb(7),
      system_elevations: countDb(1),
      system_bootstrap_grants: countDb(1),
      system_recovery_tests: countDb(2),
      system_retention_runs: fakeTable({ singles: [{ data: { status: "completed", mode: "execute", created_at: "2026-02-01T00:00:00Z" }, error: null }] }),
    });
    const r = await securityReadiness(db);
    expect(r.configured).toBe(true);
    expect(r.devices.total).toBe(3);
    expect(r.devices.by_auth_method.hmac_sha256).toBe(3);
    expect(r.device_auth_24h.rejected).toBe(7);
    expect(r.active_elevations).toBe(1);
    expect(r.bootstrap_grants).toBe(1);
    expect(r.recovery_tests).toBe(2);
    expect(r.retention_last_run?.status).toBe("completed");
    expect(r.kek.current_version).toBe("k1");
    // No enc/secret material anywhere in the payload.
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("device_secret_enc");
    expect(blob).not.toContain(SECRET);
  });

  it("null db → configured:false honest empty state", async () => {
    const r = await securityReadiness(null);
    expect(r.configured).toBe(false);
    expect(r.devices.total).toBeNull();
  });
});

/* ── Configurable overlap window ────────────────────────────────────────── */

describe("rotationWindowMs — DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS", () => {
  it("defaults to 72h when unset", () => {
    expect(rotationWindowMs()).toBe(72 * 3_600_000);
  });

  it("parses a valid hour value", () => {
    process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = "24";
    expect(rotationWindowMs()).toBe(24 * 3_600_000);
  });

  it("clamps to 1–168h", () => {
    process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = "0";
    expect(rotationWindowMs()).toBe(1 * 3_600_000);
    process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = "999";
    expect(rotationWindowMs()).toBe(168 * 3_600_000);
    process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = "168";
    expect(rotationWindowMs()).toBe(168 * 3_600_000);
  });

  it("invalid values fall back to 72h", () => {
    for (const bad of ["abc", "NaN", "1.5x", " "]) {
      process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = bad;
      expect(rotationWindowMs(), bad).toBe(72 * 3_600_000);
    }
  });

  it("startCredentialRotation honors the configured window + audits it", async () => {
    process.env.DEVICE_CREDENTIAL_ROTATION_WINDOW_HOURS = "24";
    const device = deviceRow();
    const devices = fakeTable({ singles: [{ data: device, error: null }, { data: { ...device, device_secret_enc_next: "x" }, error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await startCredentialRotation(db, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ttl = Date.parse(String((devices._update as Record<string, unknown>).credential_next_expires_at)) - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3_600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000);
    const evt = ((audit._inserts ?? []) as Record<string, unknown>[]).find((r) => r.action === "kiosk.credential_rotation_started");
    expect((evt?.detail as Record<string, unknown>)?.window_hours).toBe(24);
  });
});

/* ── Rotation status flags ──────────────────────────────────────────────── */

describe("deviceCredentialStatus — rotationOverdue / rotationAgeHours", () => {
  it("live pending rotation: pending=true, overdue=false, age is a number", () => {
    const s = deviceCredentialStatus(rotatingRow(), NOW);
    expect(s.state).toBe("active");
    if (s.state !== "active") return;
    expect(s.rotationPending).toBe(true);
    expect(s.rotationOverdue).toBe(false);
    expect(typeof s.rotationAgeHours).toBe("number");
    expect(s.rotationAgeHours).toBeGreaterThanOrEqual(0);
    expect(s.rotationNextExpiresAt).toBeTruthy();
  });

  it("lapsed staged slot: pending=false, overdue=true, expiry still surfaced", () => {
    const row = rotatingRow({ credential_next_expires_at: "2026-01-20T00:00:00Z" }); // before NOW
    const s = deviceCredentialStatus(row, NOW);
    expect(s.state).toBe("active");
    if (s.state !== "active") return;
    expect(s.rotationPending).toBe(false);
    expect(s.rotationOverdue).toBe(true);
    expect(s.rotationAgeHours).toBeGreaterThan(0);
    expect(s.rotationNextExpiresAt).toBe("2026-01-20T00:00:00Z");
  });

  it("no staged slot: both flags false, age 0", () => {
    const s = deviceCredentialStatus(deviceRow(), NOW);
    expect(s.state).toBe("active");
    if (s.state !== "active") return;
    expect(s.rotationPending).toBe(false);
    expect(s.rotationOverdue).toBe(false);
    expect(s.rotationAgeHours).toBe(0);
    expect(s.rotationNextExpiresAt).toBeNull();
  });
});

/* ── Expired next slot: fail-closed, never promoted ─────────────────────── */

describe("expired next slot — verify path", () => {
  it("expired next → bad_signature AND no promotion/credential write", async () => {
    const expired = rotatingRow({ credential_next_expires_at: "2026-01-20T00:00:00Z" });
    const { db, devices } = dbFor(expired, [{ data: { id: DEVICE_UUID }, error: null }]);
    const res = await verifyDeviceAuth(db, signedReq(NEXT_SECRET), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
    const updates = (devices._updates ?? []) as Record<string, unknown>[];
    expect(updates.every((u) => u.credential_rotated_at === undefined && u.device_secret_enc === undefined && u.device_secret_enc_next === undefined)).toBe(true);
  });
});

/* ── Revocation during pending rotation ─────────────────────────────────── */

describe("revokeDeviceCredential mid-rotation", () => {
  it("kills BOTH slots — neither old nor pending-new secret can authenticate", async () => {
    const device = rotatingRow();
    const revokedRow = deviceRow({
      auth_method: "none",
      device_secret_enc: null,
      device_secret_enc_next: null,
      device_secret_hash: null,
      credential_next_expires_at: null,
      credential_revoked_at: NOW.toISOString(),
    });
    const devices = fakeTable({ singles: [{ data: revokedRow, error: null }] });
    const dbRev = fakeDb({ system_devices: devices });
    const res = await revokeDeviceCredential(dbRev, device, { id: "op", role: "sysadmin" });
    expect(res.ok).toBe(true);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_enc).toBeNull();
    expect(patch.device_secret_enc_next).toBeNull();
    expect(patch.credential_next_expires_at).toBeNull();

    for (const secret of [SECRET, NEXT_SECRET]) {
      const { db } = dbFor(revokedRow);
      const r = await verifyDeviceAuth(db, signedReq(secret), NOW);
      expect(r.ok).toBe(false);
    }
  });
});

/* ── Concurrency ────────────────────────────────────────────────────────── */

describe("concurrent credential-rotation transitions", () => {
  it("two concurrent promotions: exactly one guarded update wins; loser no-ops safely", async () => {
    const row = rotatingRow();
    const nextEnc = row.device_secret_enc_next as string;
    // maybeSingle consumption order: findDevice ×2, then promote ×2.
    // The winner's guarded update (.eq device_secret_enc_next=nextEnc) returns
    // the row; the loser's matches nothing → promoteCredentialRotation=false.
    const devices = fakeTable({ singles: [
      { data: row, error: null },
      { data: row, error: null },
      { data: { id: DEVICE_UUID }, error: null },
      { data: null, error: null },
    ] });
    const messages = fakeTable();
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_device_messages: messages, system_audit_events: audit });

    const [r1, r2] = await Promise.all([
      verifyDeviceAuth(db, signedReq(NEXT_SECRET), NOW),
      verifyDeviceAuth(db, signedReq(NEXT_SECRET), NOW),
    ]);
    // Both authentications succeed — the credential itself is valid; only the
    // promotion write is single-winner.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Both calls issue the guarded update; the DB-side eq(device_secret_enc_next)
    // lets exactly one land — proven by exactly one promotion audit + one
    // telemetry claim flagged rotation:"promoted".
    const promotions = ((devices._updates ?? []) as Record<string, unknown>[]).filter((u) => u.device_secret_enc === nextEnc);
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    const completed = ((audit._inserts ?? []) as Record<string, unknown>[]).filter((r) => r.action === "kiosk.credential_rotation_completed");
    expect(completed).toHaveLength(1);
    const promotedClaims = ((messages._inserts ?? []) as Record<string, unknown>[]).filter(
      (r) => r.message_type === "claim" && (r.detail as Record<string, unknown>)?.rotation === "promoted",
    );
    expect(promotedClaims).toHaveLength(1);
  });

  it("start then cancel: staged slot is cleared and both transitions audited", async () => {
    const device = deviceRow();
    // singles feed the .single() of each update in call order: start's update
    // returns the staged row, cancel's update returns the cleared row.
    const devices = fakeTable({ singles: [
      { data: rotatingRow(), error: null },
      { data: rotatingRow({ device_secret_enc_next: null, credential_next_expires_at: null }), error: null },
    ] });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const actor = { id: "op", role: "sysadmin" };

    const start = await startCredentialRotation(db, device, actor);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.device.device_secret_enc_next).toBeTruthy();

    const cancel = await cancelCredentialRotation(db, start.device, actor);
    expect(cancel.ok).toBe(true);

    const updates = devices._updates as Record<string, unknown>[];
    expect(updates[0].device_secret_enc_next).toMatch(/^v2\./);
    expect(updates[1].device_secret_enc_next).toBeNull();
    expect(updates[1].credential_next_expires_at).toBeNull();
    const actions = ((audit._inserts ?? []) as Record<string, unknown>[]).map((r) => r.action);
    expect(actions).toContain("kiosk.credential_rotation_started");
    expect(actions).toContain("kiosk.credential_rotation_cancelled");
  });
});

/* ── sweepExpiredRotations ──────────────────────────────────────────────── */

describe("sweepExpiredRotations — expired pending-slot cleanup", () => {
  const EXPIRED_PENDING = {
    id: DEVICE_UUID,
    device_uid: UID,
    device_secret_enc_next: "v2.k1.deadbeef",
    credential_next_expires_at: "2026-01-20T00:00:00Z",
  };

  it("clears ONLY next-slot fields on expired pendings and audits per device as cron", async () => {
    const devices = fakeTable({ list: { data: [EXPIRED_PENDING], error: null } });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await sweepExpiredRotations(db);
    expect(res).toMatchObject({ ok: true, swept: 1 });

    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_enc_next).toBeNull();
    expect(patch.credential_next_expires_at).toBeNull();
    // Primary credential material is never touched by the sweep.
    expect(patch.device_secret_enc).toBeUndefined();
    expect(patch.device_secret_hash).toBeUndefined();
    expect(patch.credential_expires_at).toBeUndefined();

    const evt = ((audit._inserts ?? []) as Record<string, unknown>[]).find((r) => r.action === "kiosk.credential_rotation_expired");
    expect(evt).toBeTruthy();
    expect(evt?.actor_id).toBe("cron");
    // systemAudit scrubs UUID-shaped fragments out of resource strings.
    expect(String(evt?.resource)).toContain("system_device");
    // No secret/enc material in the audit detail.
    expect(JSON.stringify(evt?.detail)).not.toContain("v2.k1.deadbeef");
  });

  it("queries only expired, still-staged rows and is bounded to 100/run", async () => {
    const devices = fakeTable({ list: { data: [], error: null } });
    const db = fakeDb({ system_devices: devices });
    await sweepExpiredRotations(db, null, 500);
    const calls = (devices._calls ?? []) as unknown[][];
    const lt = calls.find((c) => c[0] === "lt" && c[1] === "credential_next_expires_at");
    expect(lt).toBeTruthy();
    expect(Date.parse(String(lt?.[2]))).toBeLessThanOrEqual(Date.now());
    expect(calls.some((c) => c[0] === "not" && c[1] === "device_secret_enc_next")).toBe(true);
    const lim = calls.find((c) => c[0] === "limit");
    expect(lim?.[1]).toBe(100); // capped at ROTATION_SWEEP_LIMIT
  });

  it("idempotent: a second run over cleared rows sweeps nothing", async () => {
    // After the first sweep the DB-side filter (enc_next not null AND expiry <
    // now) no longer matches — model the post-sweep state directly.
    const devices = fakeTable({ list: { data: [], error: null } });
    const audit = fakeTable();
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await sweepExpiredRotations(db);
    expect(res).toMatchObject({ ok: true, swept: 0 });
    expect(devices._updates ?? []).toHaveLength(0);
    expect((audit._inserts ?? [])).toHaveLength(0);
  });

  it("unexpired pendings are excluded by the expiry cutoff", async () => {
    const devices = fakeTable({ list: { data: [], error: null } });
    const db = fakeDb({ system_devices: devices });
    await sweepExpiredRotations(db);
    const calls = (devices._calls ?? []) as unknown[][];
    const lt = calls.find((c) => c[0] === "lt" && c[1] === "credential_next_expires_at");
    // The cutoff is ~now — any unexpired pending (expiry > now) is excluded by
    // the query itself, so the sweep cannot touch live rotations.
    expect(Date.parse(String(lt?.[2]))).toBeGreaterThan(Date.parse("2026-01-20T00:00:00Z"));
    expect(Date.parse(String(lt?.[2]))).toBeLessThanOrEqual(Date.now());
  });
});

