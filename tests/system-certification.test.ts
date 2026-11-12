import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* Route-level mocks (hoisted) — same pattern as system-credential-rotation.test.ts.
 * The route's pure helpers (canonicalJson / certificationRecordHash /
 * verifyCertificationChain) are unaffected; these only serve auth + service client. */
const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  devAuth: () => false,
  isStaff: (u: { role?: string } | null) => u?.role === "admin",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import {
  GET, POST,
  canonicalJson, certificationRecordHash, verifyCertificationChain,
  type CertificationRunRow,
} from "@/app/api/system/kiosks/certification/route";
import { resetRateLimits } from "@/lib/rate-limit";

/* ── Stateful in-memory Supabase stub (same philosophy as
 *    tests/hardware-certification.test.ts — real rows, real filters). ────── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
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
    filter() { return this; }

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

const DEVICE_UUID = "66666666-6666-4666-8666-666666666666";
const ACTOR = { id: "op-1", email: "op@zapnivo.com", role: "staff", organizationId: null };

function seedDb(opts: { role?: string; elevation?: boolean } = {}) {
  const now = Date.now();
  const { db, tables } = fakeDb({
    profiles: [{ id: ACTOR.id, system_role: opts.role ?? "sysadmin", system_suspended: false }],
    system_devices: [{
      id: DEVICE_UUID, device_uid: "kiosk-cert-x", serial_number: "SN-X",
      status: "active", created_at: new Date(now).toISOString(),
    }],
    system_certification_runs: [],
    system_audit_events: [],
    system_elevations: opts.elevation
      ? [{
          id: "elev-1", profile_id: ACTOR.id, method: "totp",
          created_at: new Date(now - 60_000).toISOString(),
          expires_at: new Date(now + 10 * 60_000).toISOString(),
          consumed_action: null, created_ip: null,
        }]
      : [],
  });
  return { db, tables };
}

function postReq(body: unknown) {
  return new Request("http://localhost/api/system/kiosks/certification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const VALID_RUN = { tier: "simulated", check_key: "hmac_auth", status: "pass" };

beforeEach(() => {
  resetRateLimits();
  session.mockResolvedValue(ACTOR);
});

/* ── Pure helpers ──────────────────────────────────────────────────────── */

describe("canonicalJson + certificationRecordHash", () => {
  it("is key-order independent and stable", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("hash changes when any content field changes", () => {
    const base = {
      device_id: null, tier: "simulated", check_key: "hmac_auth", status: "pass",
      detail: null, actor_id: "op-1", prev_hash: null, created_at: "2026-02-01T00:00:00Z",
    };
    const h1 = certificationRecordHash(base);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(certificationRecordHash({ ...base, status: "fail" })).not.toBe(h1);
    expect(certificationRecordHash({ ...base, prev_hash: h1 })).not.toBe(h1);
  });
});

/* ── POST: validation + permissions ────────────────────────────────────── */

describe("POST /api/system/kiosks/certification", () => {
  it("rejects an invalid tier (zod; DB CHECK mirrors it in migration 0051)", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await POST(postReq({ ...VALID_RUN, tier: "hardware_verified" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("rejects an unknown check_key", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await POST(postReq({ ...VALID_RUN, check_key: "not_a_check" }));
    expect(res.status).toBe(400);
  });

  it("viewer role cannot record runs (403)", async () => {
    const { db } = seedDb({ role: "viewer" });
    service.mockReturnValue(db);
    const res = await POST(postReq(VALID_RUN));
    expect(res.status).toBe(403);
  });

  it("404s when device_id does not match a system_devices row", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await POST(postReq({ ...VALID_RUN, device_id: "77777777-7777-4777-8777-777777777777" }));
    expect(res.status).toBe(404);
  });
});

/* ── POST: elevation gate for physical tier ────────────────────────────── */

describe("POST physical tier — step-up elevation", () => {
  const PHYSICAL = { tier: "physical", check_key: "dispense_ack", status: "pass" };

  it("403 step_up_required without a live elevation", async () => {
    const { db } = seedDb({ elevation: false });
    service.mockReturnValue(db);
    const res = await POST(postReq(PHYSICAL));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe("step_up_required");
  });

  it("records successfully with a live elevation", async () => {
    const { db, tables } = seedDb({ elevation: true });
    service.mockReturnValue(db);
    const res = await POST(postReq(PHYSICAL));
    expect(res.status).toBe(201);
    expect(tables.system_certification_runs).toHaveLength(1);
  });

  it("simulated/gateway_contract tiers do NOT require elevation", async () => {
    const { db } = seedDb({ elevation: false });
    service.mockReturnValue(db);
    const r1 = await POST(postReq(VALID_RUN));
    expect(r1.status).toBe(201);
    const r2 = await POST(postReq({ tier: "gateway_contract", check_key: "idempotency_keys", status: "pass" }));
    expect(r2.status).toBe(201);
  });
});

/* ── POST: hash chain + audit + detail sanitization ────────────────────── */

describe("POST hash chain + audit + sanitization", () => {
  it("run2.prev_hash === run1.record_hash (same device+tier chain)", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    const r1 = await POST(postReq({ ...VALID_RUN, device_id: DEVICE_UUID }));
    expect(r1.status).toBe(201);
    const run1 = (await r1.json()).run as CertificationRunRow;
    expect(run1.prev_hash).toBeNull(); // genesis
    expect(run1.record_hash).toMatch(/^[0-9a-f]{64}$/);

    const r2 = await POST(postReq({ ...VALID_RUN, check_key: "heartbeat", device_id: DEVICE_UUID }));
    expect(r2.status).toBe(201);
    const run2 = (await r2.json()).run as CertificationRunRow;
    expect(run2.prev_hash).toBe(run1.record_hash);
    expect(run2.record_hash).not.toBe(run1.record_hash);
    expect(tables.system_certification_runs).toHaveLength(2);
  });

  it("different tier starts a NEW chain (prev_hash null)", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    await POST(postReq(VALID_RUN)); // simulated, fleet-level
    const res = await POST(postReq({ tier: "gateway_contract", check_key: "ack_correlation", status: "blocked" }));
    expect(res.status).toBe(201);
    const run = (await res.json()).run as CertificationRunRow;
    expect(run.prev_hash).toBeNull();
  });

  it("writes a kiosk.certification_recorded audit event", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    await POST(postReq(VALID_RUN));
    const audit = tables.system_audit_events as Row[];
    expect(audit.some((a) => a.action === "kiosk.certification_recorded")).toBe(true);
  });

  it("strips credential-shaped keys from detail before storage", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    const res = await POST(postReq({
      ...VALID_RUN,
      detail: {
        note: "suite run 42",
        api_key: "should-not-persist",
        nested: { password: "also-no", safe_field: 1 },
      },
    }));
    expect(res.status).toBe(201);
    const run = (await res.json()).run as CertificationRunRow;
    const detail = run.detail as Record<string, unknown>;
    expect(detail.note).toBe("suite run 42");
    expect(detail.api_key).toBeUndefined();
    expect((detail.nested as Record<string, unknown>).password).toBeUndefined();
    expect((detail.nested as Record<string, unknown>).safe_field).toBe(1);
    // And the stored row itself carries no secret material.
    expect(JSON.stringify(tables.system_certification_runs)).not.toContain("should-not-persist");
    expect(JSON.stringify(tables.system_certification_runs)).not.toContain("also-no");
  });
});

/* ── Tamper detection ─────────────────────────────────────────────────── */

describe("verifyCertificationChain", () => {
  function chainRuns(): CertificationRunRow[] {
    const mk = (over: Partial<CertificationRunRow>): CertificationRunRow => ({
      id: "r", device_id: null, tier: "simulated", check_key: "hmac_auth",
      status: "pass", detail: null, actor_id: "op-1",
      created_at: "2026-02-01T00:00:00Z", record_hash: "", prev_hash: null, ...over,
    });
    const r1 = mk({ id: "r1", created_at: "2026-02-01T00:00:00Z" });
    r1.record_hash = certificationRecordHash(r1);
    const r2 = mk({ id: "r2", check_key: "heartbeat", created_at: "2026-02-01T00:01:00Z", prev_hash: r1.record_hash });
    r2.record_hash = certificationRecordHash(r2);
    return [r1, r2];
  }

  it("accepts an intact chain (order-independent input)", () => {
    const runs = chainRuns();
    expect(verifyCertificationChain([runs[1], runs[0]]).ok).toBe(true);
  });

  it("detects a mutated content field (record_hash_mismatch)", () => {
    const runs = chainRuns();
    runs[1].status = "fail"; // tamper after the fact
    const res = verifyCertificationChain(runs);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("record_hash_mismatch");
    expect(res.brokenIndex).toBe(1);
  });

  it("detects a deleted middle run (prev_hash_mismatch)", () => {
    const runs = chainRuns();
    const r3 = { ...runs[1], id: "r3", check_key: "inventory_reporting", created_at: "2026-02-01T00:02:00Z", prev_hash: runs[1].record_hash };
    r3.record_hash = certificationRecordHash(r3);
    // Delete runs[1]: r3's prev_hash no longer matches r1's record_hash.
    const res = verifyCertificationChain([runs[0], r3]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("prev_hash_mismatch");
  });
});

/* ── GET ──────────────────────────────────────────────────────────────── */

describe("GET /api/system/kiosks/certification", () => {
  it("lists runs latest-first and honors tier filter", async () => {
    const { db, tables } = seedDb();
    service.mockReturnValue(db);
    await POST(postReq(VALID_RUN));
    await POST(postReq({ tier: "gateway_contract", check_key: "idempotency_keys", status: "blocked" }));
    expect(tables.system_certification_runs).toHaveLength(2);

    const all = await GET(new Request("http://localhost/api/system/kiosks/certification"));
    expect(all.status).toBe(200);
    const allJson = await all.json();
    expect(allJson.count).toBe(2);

    const filtered = await GET(new Request("http://localhost/api/system/kiosks/certification?tier=simulated"));
    const fJson = await filtered.json();
    expect(fJson.count).toBe(1);
    expect(fJson.runs[0].tier).toBe("simulated");
  });

  it("rejects a bogus tier filter with 400", async () => {
    const { db } = seedDb();
    service.mockReturnValue(db);
    const res = await GET(new Request("http://localhost/api/system/kiosks/certification?tier=bogus"));
    expect(res.status).toBe(400);
  });

  it("viewer CAN list runs (view perm)", async () => {
    const { db } = seedDb({ role: "viewer" });
    service.mockReturnValue(db);
    const res = await GET(new Request("http://localhost/api/system/kiosks/certification"));
    expect(res.status).toBe(200);
  });
});
