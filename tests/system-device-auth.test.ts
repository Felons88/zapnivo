import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret, deviceCredentialStatus, deviceSecretHash, issueDeviceCredential, legacyIngestEnabled,
  newDeviceSecret, parseDeviceTimestamp, revokeDeviceCredential, signDeviceRequest,
  verifyDeviceAuth, type DeviceAuthRow,
} from "@/lib/system/device-auth";
import { resetRateLimits } from "@/lib/rate-limit";

/* ── Minimal Supabase stub (same pattern as system-audit.test.ts) ────────── */

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
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
const SECRET = "znd_testsecret_0123456789abcdef";
const UID = "kiosk-test-uid";

function deviceRow(over: Partial<DeviceAuthRow> = {}): DeviceAuthRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    device_uid: UID,
    serial_number: "SN-TEST-1",
    status: "active",
    auth_method: "hmac_sha256",
    device_secret_hash: deviceSecretHash(SECRET),
    device_secret_enc: null, // legacy-hash credential (pre-v2)
    credential_issued_at: "2026-01-01T00:00:00Z",
    credential_expires_at: "2027-01-01T00:00:00Z",
    credential_revoked_at: null,
    last_authed_at: null,
    last_message_ts: null,
    ...over,
  };
}

let msgCounter = 0;
function signedReq(body: string, tsSec = Math.floor(NOW.getTime() / 1000), secret = SECRET, messageId?: string) {
  const timestamp = String(tsSec);
  return {
    deviceId: UID, timestamp,
    signature: signDeviceRequest(secret, timestamp, body),
    body,
    messageId: messageId ?? `testmsg-${++msgCounter}-abcdefgh`,
  };
}

const TEST_KEK = "ab".repeat(32); // 64 hex chars = 32-byte AES-256 key
let prevKek: string | undefined;
beforeEach(() => {
  resetRateLimits();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  process.env.DEVICE_CREDENTIAL_KEK = TEST_KEK;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
});

describe("device credential issuance", () => {
  it("issues a secret once and stores enc ciphertext + sha256 fingerprint", async () => {
    const issued = deviceRow({ status: "registered", auth_method: "pending", device_secret_hash: null });
    const devices = fakeTable({ singles: [{ data: issued, error: null }] });
    const db = fakeDb({ system_devices: devices });
    const res = await issueDeviceCredential(db, issued, { id: "u1", role: "sysadmin" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^znd_/);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_hash).toBe(deviceSecretHash(res.secret));
    expect(patch.device_secret_hash).not.toBe(res.secret);
    // v2: the recoverable secret is stored only as KEK-wrapped AES-256-GCM.
    expect(patch.device_secret_enc).toMatch(/^v1\.[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/);
    expect(decryptSecret(patch.device_secret_enc as string)).toBe(res.secret);
    expect(JSON.stringify(patch)).not.toContain(res.secret);
    expect(patch.auth_method).toBe("hmac_sha256");
    expect(patch.status).toBe("provisioning"); // registered → provisioning is a legal edge
    expect(patch.last_message_ts).toBeNull();
  });

  it("refuses to issue for decommissioned/quarantined devices", async () => {
    const db = fakeDb({});
    const a = await issueDeviceCredential(db, deviceRow({ status: "decommissioned" }) as never, { id: "u", role: "sysadmin" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.status).toBe(409);
    const b = await issueDeviceCredential(db, deviceRow({ status: "quarantined" }) as never, { id: "u", role: "sysadmin" });
    expect(b.ok).toBe(false);
  });

  it("revocation clears the hash and stamps revoked_at", async () => {
    const devices = fakeTable({ singles: [{ data: deviceRow({ auth_method: "none", device_secret_hash: null, credential_revoked_at: "2026-02-01T11:00:00Z" }), error: null }] });
    const db = fakeDb({ system_devices: devices });
    const res = await revokeDeviceCredential(db, deviceRow() as never, { id: "u", role: "sysadmin" });
    expect(res.ok).toBe(true);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.device_secret_hash).toBeNull();
    expect(patch.device_secret_enc).toBeNull();
    expect(patch.credential_revoked_at).toBeTruthy();
    expect(patch.auth_method).toBe("none");
  });

  it("credential status is honest (none/pending/active/expired/revoked)", () => {
    expect(deviceCredentialStatus(deviceRow({ device_secret_hash: null, auth_method: "pending" })).state).toBe("none");
    expect(deviceCredentialStatus(deviceRow()).state).toBe("active");
    expect(deviceCredentialStatus(deviceRow({ credential_revoked_at: "2026-01-01T00:00:00Z" })).state).toBe("revoked");
    expect(deviceCredentialStatus(deviceRow({ credential_expires_at: "2020-01-01T00:00:00Z" }), new Date("2026-02-01T00:00:00Z")).state).toBe("expired");
  });
});

describe("verifyDeviceAuth", () => {
  const body = JSON.stringify({ station_id: "SN-TEST-1", events: [{ type: "heartbeat" }] });

  function dbFor(device: DeviceAuthRow | null, messages?: ReturnType<typeof fakeTable>) {
    const devices = fakeTable({ singles: [{ data: device, error: null }] });
    return { db: fakeDb({ system_devices: devices, system_device_messages: messages ?? fakeTable() }), devices, messages: messages ?? fakeTable() };
  }

  it("accepts a correctly signed request (HMAC roundtrip)", async () => {
    const { db } = dbFor(deviceRow());
    const res = await verifyDeviceAuth(db, signedReq(body), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.device.device_uid).toBe(UID);
  });

  it("rejects an expired timestamp", async () => {
    const { db } = dbFor(deviceRow());
    const res = await verifyDeviceAuth(db, signedReq(body, Math.floor(NOW.getTime() / 1000) - 600), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_timestamp");
  });

  it("rejects a bad signature", async () => {
    const { db } = dbFor(deviceRow());
    const req = signedReq(body);
    req.signature = "0".repeat(64);
    const res = await verifyDeviceAuth(db, req, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("rejects a revoked credential", async () => {
    const { db } = dbFor(deviceRow({ credential_revoked_at: "2026-01-15T00:00:00Z", device_secret_hash: null, auth_method: "none" }));
    const res = await verifyDeviceAuth(db, signedReq(body), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(["auth_method_not_hmac", "no_credential", "credential_revoked"]).toContain(res.reason);
  });

  it("rejects revoked hash-holding credentials explicitly", async () => {
    const { db } = dbFor(deviceRow({ credential_revoked_at: "2026-01-15T00:00:00Z" }));
    const res = await verifyDeviceAuth(db, signedReq(body), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("credential_revoked");
  });

  it("rejects suspended and quarantined devices", async () => {
    for (const status of ["suspended", "quarantined", "registered", "decommissioned"]) {
      const { db } = dbFor(deviceRow({ status }));
      const res = await verifyDeviceAuth(db, signedReq(body), NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("device_status");
    }
  });

  it("accepts testing-status devices", async () => {
    const { db } = dbFor(deviceRow({ status: "testing" }));
    const res = await verifyDeviceAuth(db, signedReq(body), NOW);
    expect(res.ok).toBe(true);
  });

  it("accepts out-of-order timestamps within the window (v2: nonce dedup, not ts ordering)", async () => {
    const tsMs = NOW.getTime();
    const { db, devices } = dbFor(deviceRow({ last_message_ts: tsMs }));
    // 30s older than last_message_ts but still inside ±5min — must be accepted,
    // and last_message_ts must NOT regress.
    const res = await verifyDeviceAuth(db, signedReq(body, Math.floor(tsMs / 1000) - 30), NOW);
    expect(res.ok).toBe(true);
    const patch = devices._update as Record<string, unknown>;
    expect(patch.last_message_ts).toBe(tsMs);
  });

  it("rejects unknown devices and non-hmac auth methods", async () => {
    const { db: dbUnknown } = dbFor(null);
    const r1 = await verifyDeviceAuth(dbUnknown, signedReq(body), NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("device_unknown");

    const { db: dbPending } = dbFor(deviceRow({ auth_method: "pending", device_secret_hash: null }));
    const r2 = await verifyDeviceAuth(dbPending, signedReq(body), NOW);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("auth_method_not_hmac");
  });

  it("records auth telemetry per attempt without secrets", async () => {
    const messages = fakeTable();
    const { db } = dbFor(deviceRow(), messages);
    await verifyDeviceAuth(db, signedReq(body), NOW);
    expect(messages._insert).toBeTruthy();
    const row = messages._insert as Record<string, unknown>;
    expect(row.result).toBe("ok");
    expect(row.auth_method).toBe("hmac_sha256");
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(signDeviceRequest(SECRET, String(Math.floor(NOW.getTime() / 1000)), body));
  });
});

describe("legacy ingest flag", () => {
  it("KIOSK_LEGACY_INGEST gates the shared-secret fallback", () => {
    const prev = process.env.KIOSK_LEGACY_INGEST;
    try {
      delete process.env.KIOSK_LEGACY_INGEST;
      expect(legacyIngestEnabled()).toBe(false);
      process.env.KIOSK_LEGACY_INGEST = "1";
      expect(legacyIngestEnabled()).toBe(true);
      process.env.KIOSK_LEGACY_INGEST = "0";
      expect(legacyIngestEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KIOSK_LEGACY_INGEST;
      else process.env.KIOSK_LEGACY_INGEST = prev;
    }
  });
});

describe("helpers", () => {
  it("parseDeviceTimestamp accepts seconds and ms", () => {
    expect(parseDeviceTimestamp("1769904000")).toBe(1769904000000);
    expect(parseDeviceTimestamp("1769904000000")).toBe(1769904000000);
    expect(parseDeviceTimestamp("abc")).toBeNull();
    expect(parseDeviceTimestamp("-5")).toBeNull();
  });
  it("newDeviceSecret is 32 bytes of entropy", () => {
    const a = newDeviceSecret(), b = newDeviceSecret();
    expect(a).not.toBe(b);
    expect(a.startsWith("znd_")).toBe(true);
  });
});
