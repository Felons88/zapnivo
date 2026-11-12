import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const { service } = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { provisionRedeemSchema, redeemProvisionToken, PROVISIONABLE_STATUSES } from "@/lib/system/provisioning";
import { POST as provisionPOST } from "@/app/api/devices/provision/route";
import { resetRateLimits } from "@/lib/rate-limit";

/* ── Stateful in-memory Supabase stub (kiosk-lifecycle QB pattern, extended
 *    with .is()/.not() and update-returns-affected for the atomic claim). ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run(): { data: Row[] | Row | null; error: { code?: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ ...item });
        return { data: items, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
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

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
const UID = "kiosk-prov-1";
const SERIAL = "SN-PROV-1";
const GATEWAY = "gw-edge-7";
const TOKEN = `znk_${"a".repeat(32)}`;
const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const KEK = "11".repeat(32);
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const PAST = () => new Date(Date.now() - 3600_000).toISOString();

function deviceRow(over: Row = {}): Row {
  return {
    id: DEVICE_ID,
    device_uid: UID,
    serial_number: SERIAL,
    gateway: GATEWAY,
    status: "registered",
    auth_method: "pending",
    device_secret_hash: null,
    device_secret_enc: null,
    device_secret_enc_next: null,
    credential_next_expires_at: null,
    credential_rotated_at: null,
    credential_issued_at: null,
    credential_expires_at: null,
    credential_revoked_at: null,
    last_authed_at: null,
    last_message_ts: null,
    provision_token_hash: TOKEN_HASH,
    provision_token_expires_at: FUTURE(),
    provision_token_used_at: null,
    ...over,
  };
}

function setup(row: Row = deviceRow()) {
  const { db, tables } = fakeDb({ system_devices: [row], system_audit_events: [], system_device_messages: [] });
  return { db, tables, device: tables.system_devices[0] };
}

const auditRows = (tables: Record<string, Row[]>) => tables.system_audit_events ?? [];
const auditJson = (tables: Record<string, Row[]>) => JSON.stringify(auditRows(tables));

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

/* ── Happy path ──────────────────────────────────────────────────────────── */

describe("redeemProvisionToken — valid redemption", () => {
  it("issues a credential once, consumes the token, audits without secrets", async () => {
    const { db, tables, device } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^znd_/);
    expect(res.device.device_uid).toBe(UID);

    // Token consumed atomically; credential fields written by issueDeviceCredential.
    expect(device.provision_token_used_at).toBeTruthy();
    expect(device.auth_method).toBe("hmac_sha256");
    expect(String(device.device_secret_enc)).toMatch(/^v2\.k1\./);
    expect(device.device_secret_hash).toBeTruthy();
    // Lifecycle: NOT pushed to active — provisioning edge only.
    expect(device.status).toBe("provisioning");

    const actions = auditRows(tables).map((r) => r.action);
    expect(actions).toContain("kiosk.provisioning_redeemed");
    expect(actions).toContain("kiosk.credential_issued");

    // No token / secret / token-hash material anywhere in audit rows.
    const blob = auditJson(tables);
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain(res.secret);
    expect(blob).not.toContain(TOKEN_HASH);
    expect(blob).not.toContain("device_secret_enc");
  });

  it("accepts matching device_uid/serial_number/gateway_id binding", async () => {
    const { db } = setup();
    const res = await redeemProvisionToken(db, {
      token: TOKEN, device_uid: UID, serial_number: SERIAL, gateway_id: GATEWAY,
    });
    expect(res.ok).toBe(true);
  });
});

/* ── Denials ─────────────────────────────────────────────────────────────── */

describe("redeemProvisionToken — denials", () => {
  it("unknown token → 401 invalid_token, audited as denied", async () => {
    const { db, tables, device } = setup();
    const res = await redeemProvisionToken(db, { token: `znk_${"b".repeat(32)}` });
    expect(res).toMatchObject({ ok: false, status: 401, code: "invalid_token" });
    expect(device.provision_token_used_at).toBeNull();
    expect(auditRows(tables).map((r) => r.action)).toContain("kiosk.provisioning_denied");
  });

  it("expired token → 403 token_expired, token NOT consumed", async () => {
    const { db, tables, device } = setup(deviceRow({ provision_token_expires_at: PAST() }));
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res).toMatchObject({ ok: false, status: 403, code: "token_expired" });
    expect(device.provision_token_used_at).toBeNull();
    expect(auditJson(tables)).not.toContain(TOKEN);
  });

  it("already-used token → 409 already_consumed", async () => {
    const usedAt = PAST();
    const { db, device } = setup(deviceRow({ provision_token_used_at: usedAt }));
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res).toMatchObject({ ok: false, status: 409, code: "already_consumed" });
    expect(device.provision_token_used_at).toBe(usedAt);
  });

  it.each(["active", "maintenance", "quarantined", "decommissioned"])(
    "status '%s' → 409 device_not_provisionable",
    async (status) => {
      const { db, device } = setup(deviceRow({ status }));
      const res = await redeemProvisionToken(db, { token: TOKEN });
      expect(res).toMatchObject({ ok: false, status: 409, code: "device_not_provisionable" });
      expect(device.provision_token_used_at).toBeNull();
    },
  );

  it.each(PROVISIONABLE_STATUSES)("status '%s' is provisionable", async (status) => {
    const { db } = setup(deviceRow({ status }));
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res.ok).toBe(true);
  });

  it("wrong device_uid binding → 403 binding_mismatch, token NOT consumed", async () => {
    const { db, device } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN, device_uid: "kiosk-OTHER" });
    expect(res).toMatchObject({ ok: false, status: 403, code: "binding_mismatch" });
    expect(device.provision_token_used_at).toBeNull();
  });

  it("wrong serial_number binding → 403 binding_mismatch", async () => {
    const { db } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN, serial_number: "SN-OTHER" });
    expect(res).toMatchObject({ ok: false, status: 403, code: "binding_mismatch" });
  });

  it("wrong gateway_id binding → 403 binding_mismatch", async () => {
    const { db } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN, gateway_id: "gw-OTHER" });
    expect(res).toMatchObject({ ok: false, status: 403, code: "binding_mismatch" });
  });
});

/* ── Single-use race ─────────────────────────────────────────────────────── */

describe("redeemProvisionToken — atomic single-use claim", () => {
  it("concurrent claims → exactly one wins, loser gets 409", async () => {
    const { db, tables } = setup();
    const [a, b] = await Promise.all([
      redeemProvisionToken(db, { token: TOKEN }),
      redeemProvisionToken(db, { token: TOKEN }),
    ]);
    const results = [a, b];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ status: 409, code: "already_consumed" });
    // Exactly one redeemed audit; the loser is a denied/consumed audit.
    const actions = auditRows(tables).map((r) => r.action);
    expect(actions.filter((x) => x === "kiosk.provisioning_redeemed")).toHaveLength(1);
  });

  it("sequential replay → second call is already_consumed", async () => {
    const { db } = setup();
    const first = await redeemProvisionToken(db, { token: TOKEN });
    expect(first.ok).toBe(true);
    const second = await redeemProvisionToken(db, { token: TOKEN });
    expect(second).toMatchObject({ ok: false, status: 409, code: "already_consumed" });
  });
});

/* ── Issuance failure recovery ───────────────────────────────────────────── */

describe("redeemProvisionToken — issuance failure", () => {
  it("KEK missing → 503, claim released (token un-consumed), audited failed", async () => {
    delete process.env.DEVICE_CREDENTIAL_KEK;
    const { db, tables, device } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res).toMatchObject({ ok: false, status: 503, code: "issuance_failed" });

    // Compensating write released the claim — token is redeemable again.
    expect(device.provision_token_used_at).toBeNull();
    expect(device.device_secret_enc).toBeNull();
    expect(device.auth_method).toBe("pending");

    const actions = auditRows(tables).map((r) => r.action);
    expect(actions).toContain("kiosk.provisioning_failed");
    expect(actions).not.toContain("kiosk.provisioning_redeemed");
    expect(auditJson(tables)).not.toContain(TOKEN);

    // Recovery: restore KEK → same token redeems successfully.
    process.env.DEVICE_CREDENTIAL_KEK = KEK;
    const retry = await redeemProvisionToken(db, { token: TOKEN });
    expect(retry.ok).toBe(true);
  });
});

/* ── Schema ──────────────────────────────────────────────────────────────── */

describe("provisionRedeemSchema", () => {
  it("accepts a bare token and rejects bad shapes / extra keys", () => {
    expect(provisionRedeemSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(provisionRedeemSchema.safeParse({ token: "not-a-token" }).success).toBe(false);
    expect(provisionRedeemSchema.safeParse({ token: TOKEN, evil: 1 }).success).toBe(false);
    expect(provisionRedeemSchema.safeParse({}).success).toBe(false);
  });
});

/* ── Route ───────────────────────────────────────────────────────────────── */

const post = (body: unknown, ip = "203.0.113.7") =>
  provisionPOST(
    new Request("http://localhost/api/devices/provision", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/devices/provision", () => {
  it("200 returns the credential contract; secret once; no token/hash echoed", async () => {
    const { db, tables } = setup();
    service.mockReturnValue(db);
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.device_uid).toBe(UID);
    expect(json.credential.auth_method).toBe("hmac_sha256");
    expect(json.credential.protocol).toBe(2);
    expect(json.credential.secret).toMatch(/^znd_/);
    expect(json.credential.headers["X-Device-Signature"]).toBeTruthy();
    expect(json.credential.ingest_url).toBe("/api/devices/events");

    const blob = JSON.stringify(json);
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain(TOKEN_HASH);
    expect(blob).not.toContain("provision_token");
    // Device row consumed; audit has redeemed, never the secret.
    expect(tables.system_devices[0].provision_token_used_at).toBeTruthy();
    expect(auditJson(tables)).not.toContain(json.credential.secret);
  });

  it("401 for an unknown token; 422 for a malformed body", async () => {
    service.mockReturnValue(setup().db);
    const bad = await post({ token: `znk_${"c".repeat(32)}` });
    expect(bad.status).toBe(401);
    const malformed = await post({ token: 42 });
    expect(malformed.status).toBe(422);
  });

  it("429 after 10 requests/min for the same IP+token", async () => {
    service.mockReturnValue(setup(deviceRow({ provision_token_hash: createHash("sha256").update(`znk_${"d".repeat(32)}`, "utf8").digest("hex") })).db);
    const tok = `znk_${"d".repeat(32)}`;
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post({ token: tok })).status;
    expect(last).toBe(429);
  });

  it("503 when Supabase is not configured", async () => {
    service.mockReturnValue(null);
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(503);
  });
});
