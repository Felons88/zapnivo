import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/* reportError is the single emit mechanism — spy on it (keep the real module
 * for scrub/newTraceId/recordLog used by systemAudit). */
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/observability")>();
  return { ...orig, reportError };
});

/* Cron-route collaborators — mocked so the route test never runs the real
 * destructive retention sweep; alert-sweep stays REAL (it is under test). */
const { runRetention, sweepExpiredRotations, serviceClient } = vi.hoisted(() => ({
  runRetention: vi.fn(async () => ({ ok: true, results: [] as { deleted: number; matched: number }[], runId: "test-run", error: undefined as string | undefined })),
  sweepExpiredRotations: vi.fn(async () => ({ ok: true, swept: 0 })),
  serviceClient: vi.fn(),
}));
vi.mock("@/lib/system/retention", () => ({ runRetention }));
vi.mock("@/lib/system/device-auth", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/system/device-auth")>();
  return { ...orig, sweepExpiredRotations };
});
vi.mock("@/lib/supabase", () => ({ serviceClient }));
vi.mock("@/lib/auth", () => ({
  getSessionUser: async () => null,
  isStaff: () => false,
}));

import { redeemProvisionToken } from "@/lib/system/provisioning";
import { recordDeviceAuthMessage } from "@/lib/system/device-auth";
import { runAlertSweep, SETTLEMENT_PENDING_STATES } from "@/lib/system/alert-sweep";
import { GET as retentionGET } from "@/app/api/cron/retention/route";
import { resetRateLimits } from "@/lib/rate-limit";

/* ── Stateful in-memory Supabase stub (provisioning-test QB pattern, extended
 *    with gte/lte and a created_at default simulating DB defaults). ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
  /** Resolves 'detail->>device_uid'-style jsonb paths to nested values. */
  const colVal = (r: Row, c: string): unknown => {
    if (!c.includes("->>")) return r[c];
    const [head, ...keys] = c.split("->>");
    let o: unknown = r[head];
    for (const k of keys) o = (o as Row | null | undefined)?.[k];
    return o;
  };

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(colVal(r, c), v)); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (colVal(r, c) ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (colVal(r, c) ?? null) !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(colVal(r, c))); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(colVal(r, c), v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(colVal(r, c), v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(colVal(r, c), v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(colVal(r, c), v) <= 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run(): { data: Row[] | Row | null; error: { code?: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) {
          // DB defaults: created_at/received_at stamped when the writer omits them.
          rows.push({ created_at: new Date().toISOString(), ...item });
        }
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
const UID = "kiosk-alert-1";
const TOKEN = `znk_${"a".repeat(32)}`;
const TOKEN2 = `znk_${"e".repeat(32)}`;
const TOKEN_HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const TOKEN2_HASH = createHash("sha256").update(TOKEN2, "utf8").digest("hex");
const KEK = "11".repeat(32);
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const PAST = () => new Date(Date.now() - 3600_000).toISOString();
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const MIN_AGO = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function deviceRow(over: Row = {}): Row {
  return {
    id: DEVICE_ID,
    device_uid: UID,
    serial_number: "SN-ALERT-1",
    gateway: null,
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
    last_heartbeat_at: null,
    provision_token_hash: TOKEN_HASH,
    provision_token_expires_at: FUTURE(),
    provision_token_used_at: null,
    ...over,
  };
}

function setup(rows: Record<string, Row[]> = {}) {
  const { db, tables } = fakeDb({
    system_devices: [deviceRow()],
    system_audit_events: [],
    system_device_messages: [],
    ...rows,
  });
  return { db, tables };
}

const auditRows = (tables: Record<string, Row[]>) => tables.system_audit_events ?? [];
const auditActions = (tables: Record<string, Row[]>) => auditRows(tables).map((r) => r.action);

/** Flattened reportError spy calls: [{ message, severity, route }] */
const emissions = () =>
  reportError.mock.calls.map((c) => {
    const err = c[0] as Error;
    const ctx = (c[1] ?? {}) as { severity?: string; route?: string };
    return { message: err?.message ?? String(c[0]), severity: ctx.severity, route: ctx.route };
  });
const burstEmissions = () => emissions().filter((e) => e.message.includes("kiosk.provisioning_failed_burst"));

let prevKek: string | undefined;
beforeEach(() => {
  resetRateLimits();
  reportError.mockClear();
  runRetention.mockClear();
  sweepExpiredRotations.mockClear();
  prevKek = process.env.DEVICE_CREDENTIAL_KEK;
  process.env.DEVICE_CREDENTIAL_KEK = KEK;
});
afterEach(() => {
  if (prevKek === undefined) delete process.env.DEVICE_CREDENTIAL_KEK;
  else process.env.DEVICE_CREDENTIAL_KEK = prevKek;
});

/* ── 1. kiosk.provisioning_failed_burst emitter ──────────────────────────── */

describe("kiosk.provisioning_failed_burst emitter", () => {
  const priorDenials = (n: number) =>
    Array.from({ length: n }, () => ({
      action: "kiosk.provisioning_denied",
      resource: `system_device:${DEVICE_ID}`,
      detail: { device_uid: UID },
      created_at: new Date().toISOString(),
    }));

  it("fires a warning at >=5 failed/denied audit events in the window", async () => {
    // 4 priors + the denial under test = 5 inside 15 min.
    const { db, tables } = setup({ system_audit_events: priorDenials(4) });
    const res = await redeemProvisionToken(db, { token: TOKEN, device_uid: "kiosk-WRONG" });
    expect(res.ok).toBe(false);
    const hits = burstEmissions();
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");
    expect(hits[0].route).toBe("api/devices/provision");
    expect(hits[0].message).toContain(UID); // per-device fingerprint scope
    // Stable fingerprint: no counts/timestamps in the message.
    expect(hits[0].message).not.toMatch(/\d{2}:\d{2}|count=/);
    expect(auditActions(tables)).toContain("kiosk.provisioning_denied");
  });

  it("does NOT fire below the threshold", async () => {
    const { db } = setup({ system_audit_events: priorDenials(3) }); // 3 + 1 = 4 < 5
    const res = await redeemProvisionToken(db, { token: TOKEN, device_uid: "kiosk-WRONG" });
    expect(res.ok).toBe(false);
    expect(burstEmissions()).toHaveLength(0);
  });

  it("does NOT fire for an unknown token (no device scope)", async () => {
    const { db } = setup({ system_audit_events: priorDenials(10) });
    const res = await redeemProvisionToken(db, { token: `znk_${"b".repeat(32)}` });
    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(burstEmissions()).toHaveLength(0);
  });

  it("alert payload contains no token/secret/hash material", async () => {
    const { db } = setup({ system_audit_events: priorDenials(4) });
    await redeemProvisionToken(db, { token: TOKEN, device_uid: "kiosk-WRONG" });
    const blob = JSON.stringify(reportError.mock.calls);
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain(TOKEN_HASH);
    expect(blob).not.toContain("znk_");
    expect(blob).not.toContain("znd_");
  });
});

/* ── 2. device.revoked_credential_attempts emitter ───────────────────────── */

describe("recordDeviceAuthMessage revoked-credential emitter", () => {
  it("emits a warning on credential_revoked rejections, fingerprinted per device", async () => {
    const { db } = fakeDb({ system_device_messages: [] });
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-1",
      authMethod: "hmac_sha256",
      result: "rejected",
      detail: { reason: "credential_revoked", device_uid: "kiosk-x" },
    });
    const hits = emissions().filter((e) => e.message.includes("credential_revoked"));
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");
    expect(hits[0].message).toContain("dev-uuid-1");
    // Same device+reason → identical message → same fingerprint (dedup).
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-1",
      result: "rejected",
      detail: { reason: "credential_revoked", device_uid: "kiosk-x" },
    });
    const again = emissions().filter((e) => e.message.includes("credential_revoked"));
    expect(again).toHaveLength(2);
    expect(again[0].message).toBe(again[1].message);
  });

  it("emits on credential_expired but NOT on other rejection reasons", async () => {
    const { db } = fakeDb({ system_device_messages: [] });
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-2",
      result: "rejected",
      detail: { reason: "credential_expired", device_uid: "kiosk-y" },
    });
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-2",
      result: "rejected",
      detail: { reason: "duplicate_message", device_uid: "kiosk-y" },
    });
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-2",
      result: "rejected",
      detail: { reason: "bad_signature", device_uid: "kiosk-y" },
    });
    await recordDeviceAuthMessage(db, {
      deviceId: "dev-uuid-2",
      result: "ok",
      detail: { device_uid: "kiosk-y" },
    });
    const hits = emissions().filter((e) => e.route === "device-auth");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain("credential_expired");
    expect(hits[0].message).toContain("dev-uuid-2");
  });
});

/* ── 3. Provisioning recovery audit + reissue no-leak ────────────────────── */

describe("provisioning recovery audit", () => {
  it("audits kiosk.provisioning_recovered when a prior failure exists within 24h", async () => {
    const { db, tables } = setup({
      system_audit_events: [
        {
          action: "kiosk.provisioning_failed",
          resource: `system_device:${DEVICE_ID}`,
          detail: { reason: "credential_issuance_failed", device_uid: UID },
          created_at: HOURS_AGO(2),
        },
      ],
    });
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res.ok).toBe(true);
    const actions = auditActions(tables);
    expect(actions).toContain("kiosk.provisioning_redeemed");
    expect(actions).toContain("kiosk.provisioning_recovered");
    const recovered = auditRows(tables).find((r) => r.action === "kiosk.provisioning_recovered");
    expect(JSON.stringify(recovered)).not.toContain(TOKEN);
    expect(JSON.stringify(recovered)).not.toContain((res as { secret?: string }).secret ?? "zzz");
  });

  it("does NOT audit recovered on a clean first redemption", async () => {
    const { db, tables } = setup();
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res.ok).toBe(true);
    expect(auditActions(tables)).not.toContain("kiosk.provisioning_recovered");
  });

  it("ignores provisioning_failed older than 24h", async () => {
    const { db, tables } = setup({
      system_audit_events: [
        {
          action: "kiosk.provisioning_failed",
          resource: `system_device:${DEVICE_ID}`,
          detail: { device_uid: UID },
          created_at: HOURS_AGO(30),
        },
      ],
    });
    const res = await redeemProvisionToken(db, { token: TOKEN });
    expect(res.ok).toBe(true);
    expect(auditActions(tables)).not.toContain("kiosk.provisioning_recovered");
  });

  it("reissue flow: a fresh token replaces the hash — the old secret can never redeem", async () => {
    // Simulates staff issueProvisionToken (kiosks.ts): NEW random token, hash
    // overwritten, used_at reset. The old token's hash no longer exists.
    const { db, tables } = setup();
    tables.system_devices[0].provision_token_hash = TOKEN2_HASH;
    tables.system_devices[0].provision_token_expires_at = FUTURE();
    tables.system_devices[0].provision_token_used_at = null;

    const oldAttempt = await redeemProvisionToken(db, { token: TOKEN });
    expect(oldAttempt).toMatchObject({ ok: false, status: 401, code: "invalid_token" });

    const newAttempt = await redeemProvisionToken(db, { token: TOKEN2 });
    expect(newAttempt.ok).toBe(true);
  });
});

/* ── 4. runAlertSweep ────────────────────────────────────────────────────── */

describe("runAlertSweep", () => {
  it("emits one warning per stale entity across all probes", async () => {
    const { db } = fakeDb({
      rental_exceptions: [
        { id: "exc-1", kind: "bank_mismatch", status: "open", created_at: HOURS_AGO(30) },
        { id: "exc-2", kind: "unknown_command", status: "open", created_at: HOURS_AGO(2) }, // too fresh
        { id: "exc-3", kind: "bank_mismatch", status: "resolved", created_at: HOURS_AGO(30) },
      ],
      device_commands: [
        { id: "cmd-1", status: "sent", created_at: MIN_AGO(30) },
        { id: "cmd-2", status: "acknowledged", created_at: MIN_AGO(30) },
        { id: "cmd-3", status: "queued", created_at: MIN_AGO(2) }, // too fresh
      ],
      system_device_commands: [
        { id: "scmd-1", state: "sent", timeout_at: MIN_AGO(5), created_at: HOURS_AGO(1) },
        { id: "scmd-2", state: "pending", timeout_at: null, created_at: MIN_AGO(30) },
        { id: "scmd-3", state: "acked", timeout_at: MIN_AGO(5), created_at: HOURS_AGO(1) },
      ],
      rentals: [
        { id: "rent-1", state: "return_pending", created_at: HOURS_AGO(48) },
        { id: "rent-2", state: "overdue", created_at: HOURS_AGO(30) },
        { id: "rent-3", state: "active", created_at: HOURS_AGO(48) },
        { id: "rent-4", state: "non_return_fee_pending", created_at: HOURS_AGO(3) }, // too fresh
      ],
      system_devices: [
        { id: "d1", device_uid: "kiosk-offline", status: "active", last_heartbeat_at: HOURS_AGO(1) },
        { id: "d2", device_uid: "kiosk-fresh", status: "active", last_heartbeat_at: MIN_AGO(2) },
        { id: "d3", device_uid: "kiosk-null", status: "testing", last_heartbeat_at: null }, // null = stale
        { id: "d4", device_uid: "kiosk-prov", status: "provisioning", last_heartbeat_at: HOURS_AGO(1) }, // not enrolled-status
      ],
    });

    const summary = await runAlertSweep(db);
    expect(summary.ok).toBe(true);
    expect(summary.checks.rental_exceptions_unresolved).toMatchObject({ status: "ok", emitted: 1 });
    expect(summary.checks.device_commands_stuck).toMatchObject({ status: "ok", emitted: 1 });
    expect(summary.checks.system_device_commands_stuck).toMatchObject({ status: "ok", emitted: 2 });
    expect(summary.checks.unresolved_settlements).toMatchObject({ status: "ok", emitted: 2 });
    expect(summary.checks.offline_devices).toMatchObject({ status: "ok", emitted: 2 }); // offline + null-heartbeat
    // +1: phase 4.4 recovery.test_overdue — no system_recovery_tests rows seeded = never tested.
    expect(summary.checks.recovery_test_overdue).toMatchObject({ status: "ok", emitted: 1 });
    expect(summary.emitted).toBe(9);

    const msgs = emissions().map((e) => e.message);
    expect(msgs.some((m) => m.includes("exception=exc-1") && m.includes("rental.exceptions_unresolved"))).toBe(true);
    expect(msgs.some((m) => m.includes("command=cmd-1") && m.includes("device.missing_dispense_ack"))).toBe(true);
    expect(msgs.some((m) => m.includes("command=scmd-2") && m.includes("system_device_commands"))).toBe(true);
    expect(msgs.some((m) => m.includes("rental=rent-1") && m.includes("finance.unresolved_settlement"))).toBe(true);
    expect(msgs.some((m) => m.includes("device=kiosk-offline") && m.includes("offline_stale_heartbeat"))).toBe(true);
    expect(msgs.some((m) => m.includes("device=kiosk-null"))).toBe(true);
    // Fresh/non-matching rows never alert.
    expect(msgs.some((m) => m.includes("exc-2") || m.includes("exc-3"))).toBe(false);
    expect(msgs.some((m) => m.includes("rent-4") || m.includes("rent-3"))).toBe(false);
    expect(msgs.some((m) => m.includes("kiosk-fresh") || m.includes("kiosk-prov"))).toBe(false);
    // Every emission is a warning via the cron route scope; no secrets/PII.
    for (const e of emissions()) {
      expect(e.severity).toBe("warning");
      expect(e.route).toBe("cron.alert_sweep");
      expect(e.message).not.toMatch(/znk_|znd_|@|\+?1?\d{3}[-.\s]\d{3}[-.\s]\d{4}/);
    }
  });

  it("tolerates missing tables — every probe skips, sweep still resolves", async () => {
    const db = { from: () => { throw new Error("relation does not exist"); } } as unknown as SupabaseClient;
    const summary = await runAlertSweep(db);
    expect(summary.ok).toBe(true);
    expect(summary.emitted).toBe(0);
    for (const check of Object.values(summary.checks)) {
      expect(check.status).toBe("skipped");
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it("tolerates per-table query errors independently", async () => {
    // rental_exceptions errors; everything else is empty-but-valid.
    const base = fakeDb({});
    const realFrom = (base.db as unknown as { from: (t: string) => unknown }).from;
    const flaky = {
      from: (t: string) => {
        if (t === "rental_exceptions") {
          const b: Record<string, unknown> = {};
          for (const m of ["select", "eq", "in", "lt", "limit"]) b[m] = () => b;
          b.then = (res: (v: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "relation rental_exceptions does not exist" } }).then(res);
          return b;
        }
        return realFrom(t);
      },
    } as unknown as SupabaseClient;
    const summary = await runAlertSweep(flaky);
    expect(summary.checks.rental_exceptions_unresolved.status).toBe("skipped");
    expect(summary.checks.device_commands_stuck.status).toBe("ok");
    expect(summary.ok).toBe(true);
  });
});

/* ── 5. Cron route wiring — dry_run skips the alert sweep ────────────────── */

describe("GET /api/cron/retention — alert sweep wiring", () => {
  const routeDb = () => fakeDb({ cron_runs: [] });

  const call = (qs: string) =>
    retentionGET(
      new Request(`http://localhost/api/cron/retention${qs}`, {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-test-secret";
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("dry_run=1 skips runAlertSweep probes but still records the step", async () => {
    const { db, tables } = routeDb();
    serviceClient.mockReturnValue(db);
    const res = await call("?dry_run=1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.alert_sweep).toMatchObject({ skipped: "dry_run" });
    // Probes would have queried these tables — none should appear in a way that
    // emitted alerts; reportError must stay silent on a dry run.
    expect(reportError).not.toHaveBeenCalled();
    const run = tables.cron_runs?.at(-1);
    expect((run?.detail as Record<string, unknown>)?.alert_sweep).toMatchObject({ skipped: "dry_run" });
  });

  it("execute mode runs the real sweep and reports the summary", async () => {
    const { db, tables } = routeDb();
    tables.rental_exceptions = [
      { id: "exc-route", kind: "no_matching_rental", status: "open", created_at: HOURS_AGO(30) },
    ];
    serviceClient.mockReturnValue(db);
    const res = await call("");
    expect(res.status).toBe(200);
    const json = await res.json();
    // emitted 2: the seeded stale exception + phase 4.4 recovery.test_overdue
    // (no system_recovery_tests rows = never tested → reminder-level alert).
    expect(json.alert_sweep).toMatchObject({ ok: true, emitted: 2 });
    expect(json.alert_sweep.checks.rental_exceptions_unresolved.emitted).toBe(1);
    const msgs = emissions().map((e) => e.message);
    expect(msgs.some((m) => m.includes("exception=exc-route"))).toBe(true);
    const run = tables.cron_runs?.at(-1);
    expect((run?.detail as Record<string, unknown>)?.alert_sweep).toMatchObject({ ok: true });
  });
});
