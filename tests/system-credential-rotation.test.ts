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
  cancelCredentialRotation, decryptSecret, deviceSecretHash, encryptSecret,
  reencryptDeviceCredential, revokeDeviceCredential,
  signDeviceRequest, startCredentialRotation, verifyDeviceAuth,
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
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _updates?: unknown[]; _inserts?: unknown[] } = { _updates: [], _inserts: [] };
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter", "gt", "lt", "gte", "lte"]) {
    b[m] = (...a: unknown[]) => {
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
beforeEach(() => {
  resetRateLimits();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  prevKekPrev = process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
  process.env.DEVICE_CREDENTIAL_KEK = KEK_A;
  delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
  if (prevKekPrev === undefined) delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
  else process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = prevKekPrev;
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
