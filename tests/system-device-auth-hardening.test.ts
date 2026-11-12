import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  credentialKeyVersion, decryptSecret, deviceSecretHash, encryptSecret, issueDeviceCredential,
  kekStatus, signDeviceRequest, verifyDeviceAuth,
  type DeviceAuthRow,
} from "@/lib/system/device-auth";
import { resetRateLimits } from "@/lib/rate-limit";

/* ── Minimal Supabase stub (same pattern as system-device-auth.test.ts) ──── */

type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _inserts?: unknown[] } = { _inserts: [] };
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") { b._insert = a[0]; (b._inserts as unknown[]).push(a[0]); }
      if (m === "update") b._update = a[0];
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
const SECRET = "znd_hardening_secret_0123456789abcdef";
const UID = "kiosk-hardening-uid";
const KEK_A = "11".repeat(32);
const KEK_B = "22".repeat(32);

function deviceRow(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    device_uid: UID,
    serial_number: "SN-HARD-1",
    status: "active",
    auth_method: "hmac_sha256",
    device_secret_hash: deviceSecretHash(SECRET),
    device_secret_enc: null,
    credential_issued_at: "2026-01-01T00:00:00Z",
    credential_expires_at: "2027-01-01T00:00:00Z",
    credential_revoked_at: null,
    last_authed_at: null,
    last_message_ts: null,
    ...over,
  };
}

const DEVICE_UUID = "22222222-2222-4222-8222-222222222222";

/** A v2 (enc-mode) device row: enc ciphertext made under KEK_A + fingerprint. */
function encDeviceRow(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return deviceRow({ device_secret_enc: encryptSecret(SECRET, DEVICE_UUID), ...over });
}

let msgCounter = 0;
function signedReq(body: string, tsSec = Math.floor(NOW.getTime() / 1000), secret = SECRET, messageId?: string) {
  const timestamp = String(tsSec);
  return {
    deviceId: UID, timestamp,
    signature: signDeviceRequest(secret, timestamp, body),
    body,
    messageId: messageId ?? `hardmsg-${++msgCounter}-abcdefgh`,
  };
}

function dbFor(device: DeviceAuthRow | null, messages?: ReturnType<typeof fakeTable>) {
  const devices = fakeTable({ singles: [{ data: device, error: null }] });
  const msgs = messages ?? fakeTable();
  return { db: fakeDb({ system_devices: devices, system_device_messages: msgs, system_audit_events: fakeTable() }), devices, messages: msgs };
}

const BODY = JSON.stringify({ station_id: "SN-HARD-1", events: [{ type: "heartbeat" }] });

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

describe("secret encryption (AES-256-GCM, KEK-wrapped, AAD-bound v2)", () => {
  it("encrypt/decrypt roundtrips (v2, keyver + AAD)", () => {
    const enc = encryptSecret(SECRET, "dev-uuid-1");
    expect(enc).toMatch(/^v2\.k1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
    expect(enc).not.toContain(SECRET);
    expect(decryptSecret(enc, "dev-uuid-1")).toBe(SECRET);
    // Two encryptions of the same secret differ (random IV).
    expect(encryptSecret(SECRET, "dev-uuid-1")).not.toBe(enc);
    // Custom keyver tag is honored.
    expect(encryptSecret(SECRET, "dev-uuid-1", "k9")).toMatch(/^v2\.k9\./);
  });

  it("AAD binds ciphertext to the device — wrong/missing AAD fails", () => {
    const enc = encryptSecret(SECRET, "device-A");
    expect(decryptSecret(enc, "device-A")).toBe(SECRET);
    expect(() => decryptSecret(enc, "device-B")).toThrow(); // swapped-row attack
    expect(() => decryptSecret(enc)).toThrow(); // v2 without AAD never verifies
  });

  it("fails closed on wrong KEK / tampering / malformed payload", () => {
    const enc = encryptSecret(SECRET, "dev-uuid-1");
    process.env.DEVICE_CREDENTIAL_KEK = KEK_B;
    expect(() => decryptSecret(enc, "dev-uuid-1")).toThrow();
    process.env.DEVICE_CREDENTIAL_KEK = KEK_A;
    const parts = enc.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}.${parts[4].slice(0, -2)}00`;
    expect(() => decryptSecret(tampered, "dev-uuid-1")).toThrow();
    expect(() => decryptSecret("not-a-payload", "dev-uuid-1")).toThrow();
    expect(() => decryptSecret("v2.aa.bb.cc", "dev-uuid-1")).toThrow();
    expect(() => decryptSecret("v9.aa.bb.cc.dd", "dev-uuid-1")).toThrow();
  });

  it("decrypts legacy v1 payloads (no AAD) for pre-existing rows", () => {
    // Hand-build a v1 ciphertext under KEK_A — the pre-0048 format.
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEK_A, "hex"), iv);
    const ct = Buffer.concat([cipher.update(SECRET, "utf8"), cipher.final()]);
    const v1 = `v1.${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ct.toString("hex")}`;
    expect(decryptSecret(v1)).toBe(SECRET);
    expect(decryptSecret(v1, "any-aad-ignored")).toBe(SECRET); // v1 ignores AAD
    expect(credentialKeyVersion(v1)).toBe("v1");
    expect(credentialKeyVersion(encryptSecret(SECRET, "d"))).toBe("k1");
  });

  it("previous KEK is tried on decrypt failure (staged rotation)", () => {
    const enc = encryptSecret(SECRET, "dev-uuid-1"); // under KEK_A
    process.env.DEVICE_CREDENTIAL_KEK = KEK_B; // current rotated
    process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS = KEK_A;
    expect(kekStatus()).toEqual({ configured: true, current_version: "k1", previous_configured: true });
    expect(decryptSecret(enc, "dev-uuid-1")).toBe(SECRET); // falls back to previous
    delete process.env.DEVICE_CREDENTIAL_KEK_PREVIOUS;
    expect(kekStatus().previous_configured).toBe(false);
    expect(() => decryptSecret(enc, "dev-uuid-1")).toThrow(); // previous unset → fail closed
  });

  it("refuses to issue when DEVICE_CREDENTIAL_KEK is unset", async () => {
    delete process.env.DEVICE_CREDENTIAL_KEK;
    const devices = fakeTable({ singles: [{ data: deviceRow({ status: "registered", device_secret_hash: null, device_secret_enc: null }), error: null }] });
    const db = fakeDb({ system_devices: devices });
    const res = await issueDeviceCredential(db, deviceRow({ status: "registered", device_secret_hash: null, device_secret_enc: null }), { id: "u", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("DEVICE_CREDENTIAL_KEK not configured");
      expect(res.status).toBe(503);
    }
    expect(devices._update).toBeUndefined(); // nothing was persisted
  });

  it("refuses to issue when DEVICE_CREDENTIAL_KEK is malformed", async () => {
    process.env.DEVICE_CREDENTIAL_KEK = "tooshort";
    const db = fakeDb({ system_devices: fakeTable() });
    const res = await issueDeviceCredential(db, deviceRow({ status: "registered" }), { id: "u", role: "sysadmin" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("64 hex");
  });
});

describe("verifyDeviceAuth — v2 key modes", () => {
  it("enc-mode: decrypts the stored secret and verifies the signature", async () => {
    const { db } = dbFor(encDeviceRow());
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.keyMode).toBe("enc");
  });

  it("enc-mode: wrong KEK at verify time fails closed (503, no signature check bypass)", async () => {
    const { db } = dbFor(encDeviceRow());
    process.env.DEVICE_CREDENTIAL_KEK = KEK_B; // ciphertext was made under KEK_A
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.reason).toBe("key_decrypt_failed");
    }
  });

  it("legacy-hash fallback still verifies and is marked key_mode=legacy_hash", async () => {
    const { db, messages } = dbFor(deviceRow({ device_secret_enc: null }));
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.keyMode).toBe("legacy_hash");
    const okRow = ((messages._inserts ?? []) as Record<string, unknown>[]).find((r) => r.result === "ok" && r.message_type !== "claim");
    expect((okRow?.detail as Record<string, unknown>)?.key_mode).toBe("legacy_hash");
  });

  it("enc-mode telemetry marks key_mode=enc on claim + ok rows", async () => {
    const { db, messages } = dbFor(encDeviceRow());
    await verifyDeviceAuth(db, signedReq(BODY), NOW);
    const rows = (messages._inserts ?? []) as Record<string, unknown>[];
    const claim = rows.find((r) => r.message_type === "claim");
    expect((claim?.detail as Record<string, unknown>)?.key_mode).toBe("enc");
  });
});

describe("verifyDeviceAuth — message id / dedup", () => {
  it("rejects a missing X-Device-Message-Id (401 missing_message_id)", async () => {
    const { db } = dbFor(encDeviceRow());
    const req = signedReq(BODY);
    const res = await verifyDeviceAuth(db, { ...req, messageId: null }, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.reason).toBe("missing_message_id");
    }
  });

  it("rejects malformed message ids", async () => {
    const { db } = dbFor(encDeviceRow());
    for (const bad of ["short", "has spaces!!", "x".repeat(129), "semi;colon", ""]) {
      const res = await verifyDeviceAuth(db, { ...signedReq(BODY), messageId: bad }, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(["missing_message_id", "invalid_message_id"]).toContain(res.reason);
    }
  });

  it("rejects invalid protocol versions", async () => {
    const { db } = dbFor(encDeviceRow());
    for (const pv of [0, -1, 1.5, 1000, Number.NaN]) {
      const res = await verifyDeviceAuth(db, { ...signedReq(BODY), protocolVersion: pv }, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid_protocol_version");
    }
  });

  it("duplicate message_id → 409 duplicate_message via unique-violation claim", async () => {
    const messages = fakeTable({ list: { data: null, error: { message: "duplicate key value", code: "23505" } } });
    const { db } = dbFor(encDeviceRow(), messages);
    const res = await verifyDeviceAuth(db, signedReq(BODY, undefined, SECRET, "dup-msg-id-12345"), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.reason).toBe("duplicate_message");
    }
    // The rejected telemetry row must NOT carry message_id (would re-trip the index).
    const rows = (messages._inserts ?? []) as Record<string, unknown>[];
    const rejected = rows.find((r) => r.result === "rejected");
    expect(rejected).toBeTruthy();
    expect(rejected?.message_id).toBeUndefined();
    expect((rejected?.detail as Record<string, unknown>)?.reason).toBe("duplicate_message");
  });

  it("non-unique claim insert failure fails closed (503 dedup_unavailable)", async () => {
    const messages = fakeTable({ list: { data: null, error: { message: "connection lost", code: "08006" } } });
    const { db } = dbFor(encDeviceRow(), messages);
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.reason).toBe("dedup_unavailable");
    }
  });

  it("claim row carries message_id, protocol_version and payload_sha256", async () => {
    const { db, messages } = dbFor(encDeviceRow());
    const mid = "claim-check-msg-1";
    await verifyDeviceAuth(db, { ...signedReq(BODY, undefined, SECRET, mid), protocolVersion: 2 }, NOW);
    const claim = ((messages._inserts ?? []) as Record<string, unknown>[]).find((r) => r.message_type === "claim");
    expect(claim?.message_id).toBe(mid);
    expect(claim?.protocol_version).toBe(2);
    expect(claim?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(claim?.result).toBe("ok");
    expect(claim?.auth_method).toBe("hmac_sha256");
  });
});

describe("verifyDeviceAuth — timestamps, revocation, secrecy", () => {
  it("accepts out-of-order timestamps in both directions within ±5min", async () => {
    const lastTs = NOW.getTime();
    // older than last_message_ts
    const { db: db1 } = dbFor(encDeviceRow({ last_message_ts: lastTs }));
    const r1 = await verifyDeviceAuth(db1, signedReq(BODY, Math.floor(lastTs / 1000) - 120), NOW);
    expect(r1.ok).toBe(true);
    // newer than last_message_ts
    const { db: db2 } = dbFor(encDeviceRow({ last_message_ts: lastTs - 600_000 }));
    const r2 = await verifyDeviceAuth(db2, signedReq(BODY), NOW);
    expect(r2.ok).toBe(true);
  });

  it("still enforces the ±5min timestamp window", async () => {
    const { db: dbPast } = dbFor(encDeviceRow());
    const r1 = await verifyDeviceAuth(dbPast, signedReq(BODY, Math.floor(NOW.getTime() / 1000) - 400), NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("bad_timestamp");
    const { db: dbFuture } = dbFor(encDeviceRow());
    const r2 = await verifyDeviceAuth(dbFuture, signedReq(BODY, Math.floor(NOW.getTime() / 1000) + 400), NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("bad_timestamp");
  });

  it("revocation still blocks enc-mode credentials", async () => {
    const { db } = dbFor(encDeviceRow({ credential_revoked_at: "2026-01-15T00:00:00Z" }));
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("credential_revoked");
  });

  it("no secret/enc/hash material leaks into results, telemetry, or audit", async () => {
    const audit = fakeTable();
    const row = encDeviceRow();
    const devices = fakeTable({ singles: [{ data: row, error: null }] });
    const messages = fakeTable();
    const db = fakeDb({ system_devices: devices, system_device_messages: messages, system_audit_events: audit });
    const res = await verifyDeviceAuth(db, signedReq(BODY), NOW);
    expect(res.ok).toBe(true);
    const enc = row.device_secret_enc as string;
    const haystacks = [
      JSON.stringify(res),
      ...(((messages._inserts ?? []) as unknown[]).map((r) => JSON.stringify(r))),
      ...(((audit._inserts ?? []) as unknown[]).map((r) => JSON.stringify(r))),
      JSON.stringify(devices._update ?? {}),
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET);
      expect(h).not.toContain("znd_");
      expect(h).not.toContain(enc);
      expect(h).not.toContain(deviceSecretHash(SECRET));
    }
  });

  it("issued credential secret never appears in the device patch or audit row", async () => {
    const audit = fakeTable();
    const devices = fakeTable({ singles: [{ data: deviceRow({ status: "registered", device_secret_hash: null, device_secret_enc: null }), error: null }] });
    const db = fakeDb({ system_devices: devices, system_audit_events: audit });
    const res = await issueDeviceCredential(db, deviceRow({ status: "registered", device_secret_hash: null, device_secret_enc: null }), { id: "u", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const patch = devices._update as Record<string, unknown>;
    expect(JSON.stringify(patch)).not.toContain(res.secret);
    for (const row of (audit._inserts ?? []) as Record<string, unknown>[]) {
      expect(JSON.stringify(row)).not.toContain(res.secret);
      expect(JSON.stringify(row)).not.toContain("znd_");
    }
  });
});
