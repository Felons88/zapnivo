import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/* ── Mocks ─────────────────────────────────────────────────────────────── */

const { dbHolder, alertStaffSpy, externalAlertSpy, alertNewIssueSpy, runAggregationMock, healthMock } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  alertStaffSpy: vi.fn(async (_db: unknown, _pref: string, _subject: string, _body: string, _html?: unknown, _meta?: unknown) => 1),
  externalAlertSpy: vi.fn(),
  alertNewIssueSpy: vi.fn(),
  runAggregationMock: vi.fn(async () => [{ day: "2026-01-01", events: 0 }]),
  healthMock: vi.fn(async (): Promise<unknown> => ({ provider: "fakeprov", status: "unconfigured", detail: "", checkedAt: "", latencyMs: null })),
}));

vi.mock("@/lib/supabase", () => ({ serviceClient: () => dbHolder.db }));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => null, isStaff: () => false }));
vi.mock("@/lib/alerts", () => ({ externalAlert: externalAlertSpy }));
vi.mock("@/lib/analytics-aggregates", () => ({ runAggregation: runAggregationMock }));

// integrations stays REAL (SECRET_REGISTRY is under test) except the provider
// list + health check, which the alert sweep probes daily (D14).
vi.mock("@/lib/system/integrations", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/system/integrations")>();
  return {
    ...orig,
    INTEGRATION_PROVIDERS: [{ id: "fakeprov", name: "Fake", category: "data" as const, purpose: "", envVars: [], configured: () => true, mode: () => "x" }],
    checkIntegrationHealth: healthMock,
  };
});

// fleet-sweep stays REAL (recordCron is under test) except alertStaff, which
// observability's alertNewIssue reaches via dynamic import — spy it there.
vi.mock("@/lib/fleet-sweep", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/fleet-sweep")>();
  return { ...orig, alertStaff: alertStaffSpy };
});

// alertNewIssue is spied for the telemetry route (which imports it directly);
// reportError's INTERNAL call still uses the real implementation.
vi.mock("@/lib/observability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/observability")>();
  return { ...orig, alertNewIssue: alertNewIssueSpy };
});

import { reportError } from "@/lib/observability";
import { POST as telemetryPOST } from "@/app/api/telemetry/route";
import { GET as uptimeGET } from "@/app/api/cron/uptime/route";
import { GET as analyticsGET } from "@/app/api/cron/analytics/route";
import { POST as inboundPOST } from "@/app/api/webhooks/email/inbound/route";
import { GET as manifestGET } from "@/app/api/kiosks/manifest/route";
import { RETENTION_POLICY, getRetentionRule } from "@/lib/system/retention";
import { SECRET_REGISTRY } from "@/lib/system/integrations";
import { CRON_ROUTES } from "@/lib/system/jobs";
import { runAlertSweep } from "@/lib/system/alert-sweep";
import { resetRateLimits } from "@/lib/rate-limit";
import { setRepoForTests } from "@/lib/helpdesk/repo";
import type { HelpdeskRepo } from "@/lib/helpdesk/repo";

/* ── Generic in-memory Supabase stub ───────────────────────────────────── */

type Row = Record<string, unknown>;

/**
 * Minimal thenable query builder. Inserts are persisted into the table store
 * (so later selects see them — matching real DB semantics incl. dedupe tests),
 * selects honor eq/neq/in/lt/lte/gt/gte + limit, and every call is awaitable.
 * `insertErrors` forces {error} results per table (non-23505 failure paths).
 */
function makeDb(seed: Record<string, Row[]> = {}, insertErrors: Record<string, { code?: string; message: string }> = {}) {
  const tables = new Map<string, Row[]>();
  for (const [k, v] of Object.entries(seed)) tables.set(k, v.map((r) => ({ ...r })));
  const inserts: Record<string, Row[]> = {};
  const rows = (name: string) => {
    let r = tables.get(name);
    if (!r) { r = []; tables.set(name, r); }
    return r;
  };
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => (String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0);

  const table = (name: string) => {
    const st = {
      op: "select" as "select" | "insert" | "update" | "delete",
      payload: null as unknown,
      filters: [] as ((r: Row) => boolean)[],
      lim: Number.POSITIVE_INFINITY,
      single: false,
      err: insertErrors[name] ?? null,
    };
    const matched = () => rows(name).filter((r) => st.filters.every((f) => f(r))).slice(0, st.lim);
    const api: Record<string, unknown> = {};
    const self = () => api;
    api.select = () => self();
    api.insert = (row: unknown) => { st.op = "insert"; st.payload = row; return self(); };
    api.update = (patch: unknown) => { st.op = "update"; st.payload = patch; return self(); };
    api.upsert = (row: unknown) => { st.op = "insert"; st.payload = row; return self(); };
    api.delete = () => { st.op = "delete"; return self(); };
    api.eq = (k: string, v: unknown) => { st.filters.push((r) => eqv(r[k], v)); return self(); };
    api.neq = (k: string, v: unknown) => { st.filters.push((r) => !eqv(r[k], v)); return self(); };
    api.in = (k: string, vals: unknown[]) => { st.filters.push((r) => vals.includes(r[k])); return self(); };
    api.is = (k: string, v: unknown) => { st.filters.push((r) => (r[k] ?? null) === v); return self(); };
    api.not = (k: string, op: string, v: unknown) => { st.filters.push((r) => (op === "is" ? (r[k] ?? null) !== v : true)); return self(); };
    api.lt = (k: string, v: string) => { st.filters.push((r) => cmp(r[k], v) < 0); return self(); };
    api.lte = (k: string, v: string) => { st.filters.push((r) => cmp(r[k], v) <= 0); return self(); };
    api.gt = (k: string, v: string) => { st.filters.push((r) => cmp(r[k], v) > 0); return self(); };
    api.gte = (k: string, v: string) => { st.filters.push((r) => cmp(r[k], v) >= 0); return self(); };
    api.or = () => self(); // not needed by tested paths
    api.order = () => self();
    api.limit = (n: number) => { st.lim = n; return self(); };
    api.range = () => self();
    api.single = () => { st.single = true; return self(); };
    api.maybeSingle = () => { st.single = true; return self(); };
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let out: { data: unknown; error: { code?: string; message: string } | null };
      if (st.err) {
        out = { data: null, error: st.err };
      } else if (st.op === "insert") {
        const payloads = Array.isArray(st.payload) ? st.payload : [st.payload];
        const written: Row[] = [];
        for (const p of payloads as Row[]) {
          const row = { id: `t-${name}-${rows(name).length + 1}`, ...p };
          rows(name).push(row);
          (inserts[name] ??= []).push(row);
          written.push(row);
        }
        out = { data: st.single ? (written[0] ?? null) : written, error: null };
      } else if (st.op === "update") {
        const m = matched();
        for (const r of m) Object.assign(r, st.payload as Row);
        out = { data: m, error: null };
      } else if (st.op === "delete") {
        const m = matched();
        const keep = rows(name).filter((r) => !m.includes(r));
        tables.set(name, keep);
        out = { data: m, error: null };
      } else {
        const m = matched();
        out = { data: st.single ? (m[0] ?? null) : m, error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return api;
  };
  return {
    from: (name: string) => table(name),
    inserts,
    tables,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  dbHolder.db = makeDb({
    profiles: [{ id: "s1", email: "staff@zapnivo.test", role: "admin" }],
    notification_prefs: [],
  });
  process.env.CRON_SECRET = "cron-test-secret";
  delete process.env.KIOSK_INGEST_SECRET;
  delete process.env.EMAIL_INBOUND_SECRET;
  setRepoForTests(null);
});

afterEach(() => {
  setRepoForTests(undefined);
  delete process.env.CRON_SECRET;
  delete process.env.KIOSK_INGEST_SECRET;
  delete process.env.EMAIL_INBOUND_SECRET;
});

/* ── D4: warning-severity alerts notify ────────────────────────────────── */

describe("D4 — warning fingerprints notify staff + external webhook", () => {
  it("reportError(severity=warning) on a NEW fingerprint calls alertStaff + externalAlert", async () => {
    reportError(new Error("sweep probe failed"), { severity: "warning", route: "cron.alert_sweep" });
    await vi.waitFor(() => expect(alertStaffSpy).toHaveBeenCalled(), { timeout: 2000 });
    expect(alertStaffSpy.mock.calls[0][1]).toBe("offline_alerts");
    expect(alertStaffSpy.mock.calls[0][2]).toContain("New warning");
    expect(alertStaffSpy.mock.calls[0][3]).toContain("sweep probe failed");
    expect(externalAlertSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^issue:/), expect.any(String), expect.any(String), "warning",
    );
  });

  it("dedup: a repeat of the same fingerprint does NOT re-alert", async () => {
    const err = () => new Error("same warning payload");
    reportError(err(), { severity: "warning", route: "cron.alert_sweep" });
    await vi.waitFor(() => expect(alertStaffSpy).toHaveBeenCalledTimes(1), { timeout: 2000 });
    reportError(err(), { severity: "warning", route: "cron.alert_sweep" });
    await flush();
    await flush();
    expect(alertStaffSpy).toHaveBeenCalledTimes(1);
  });

  it("severity=error stays dashboard-only (no staff alert)", async () => {
    reportError(new Error("plain error"), { severity: "error", route: "test" });
    await flush();
    await flush();
    expect(alertStaffSpy).not.toHaveBeenCalled();
    expect(externalAlertSpy).not.toHaveBeenCalled();
  });
});

/* ── D11: telemetry severity cap + alert path ──────────────────────────── */

describe("D11 — telemetry error ingest", () => {
  const postError = (severity: string, message: string) =>
    telemetryPOST(new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ type: "error", name: "TypeError", message, route: "/x", severity }),
    }) as never);

  it("caps client-claimed 'critical' at 'warning' and routes new issues through alertNewIssue", async () => {
    const res = await postError("critical", "client boom");
    expect(res.status).toBe(200);
    const db = dbHolder.db as ReturnType<typeof makeDb>;
    const ev = db.inserts["error_events"]?.at(-1) as Row;
    const issue = db.inserts["error_issues"]?.at(-1) as Row;
    expect(ev?.severity).toBe("warning");
    expect(issue?.severity).toBe("warning");
    await vi.waitFor(() => expect(alertNewIssueSpy).toHaveBeenCalled(), { timeout: 2000 });
    expect(alertNewIssueSpy.mock.calls[0][1]).toBe(issue?.id);
  });

  it("'error' severity does not alert", async () => {
    await postError("error", "minor client bug");
    await flush();
    expect(alertNewIssueSpy).not.toHaveBeenCalled();
  });
});

/* ── D1/D2/D3/D8: cron routes record cron_runs + alert on failure ───────── */

describe("cron routes — recordCron coverage", () => {
  it("uptime records a cron_runs row and returns probe results", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as never;
    try {
      const res = await uptimeGET(new Request("http://localhost/api/cron/uptime", {
        headers: { authorization: "Bearer cron-test-secret" },
      }));
      const j = await res.json();
      expect(j.ok).toBe(true);
      expect(j.checked).toBeGreaterThan(0);
      const db = dbHolder.db as ReturnType<typeof makeDb>;
      const run = db.inserts["cron_runs"]?.at(-1) as Row;
      expect(run?.job).toBe("uptime");
      expect(run?.ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("analytics failure writes cron_runs ok:false AND emails staff", async () => {
    runAggregationMock.mockRejectedValueOnce(new Error("agg exploded"));
    const queueEmail = vi.fn(async (_email: { subject?: string }) => ({}));
    setRepoForTests({ queueEmail, listEmails: async () => [] } as unknown as HelpdeskRepo);
    const res = await analyticsGET(new Request("http://localhost/api/cron/analytics", {
      headers: { authorization: "Bearer cron-test-secret" },
    }));
    expect(res.status).toBe(500);
    const db = dbHolder.db as ReturnType<typeof makeDb>;
    const run = db.inserts["cron_runs"]?.at(-1) as Row;
    expect(run?.job).toBe("analytics");
    expect(run?.ok).toBe(false);
    // recordCron → alertStaff → staffRecipients(profiles seeded) → repo.queueEmail
    await vi.waitFor(() => expect(queueEmail).toHaveBeenCalled(), { timeout: 2000 });
    expect(String(queueEmail.mock.calls[0][0]?.subject)).toContain("Cron job failed");
  });
});

/* ── D7: inbound webhook enqueue failure ───────────────────────────────── */

describe("D7 — inbound webhook non-duplicate insert failure", () => {
  const SECRET = "inbound-secret";
  const post = () => inboundPOST(new Request(`http://localhost/api/webhooks/email/inbound?key=${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{
        MessageId: "<fail-1@x>", From: { Address: "a@b.com" }, To: [{ Address: "support@in.zapnivo.com" }],
        Subject: "hello", RawTextBody: "body", Headers: {},
      }],
    }),
  }));

  it("records an inbound_emails 'error' row, reports, and returns 500 for retry", async () => {
    process.env.EMAIL_INBOUND_SECRET = SECRET;
    dbHolder.db = makeDb({}, { inbound_jobs: { code: "XX000", message: "connection reset" } });
    const res = await post();
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, error: "enqueue_failed", failed: 1, queued: 0 });
    const db = dbHolder.db as ReturnType<typeof makeDb>;
    const audit = db.inserts["inbound_emails"]?.at(-1) as Row;
    expect(audit?.status).toBe("error");
    expect(String(audit?.reason)).toContain("enqueue_failed");
    expect(db.inserts["error_events"]?.length).toBeGreaterThan(0);
  });
});

/* ── D10: rate limits on kiosk bearer endpoints ────────────────────────── */

describe("D10 — kiosk endpoint rate limits", () => {
  it("manifest 429s after 60 req/min per IP (before auth work)", async () => {
    process.env.KIOSK_INGEST_SECRET = "kiosk-secret";
    const ip = "203.0.113.9";
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await manifestGET(new Request(`http://localhost/api/kiosks/manifest?station_id=ABC123`, {
        headers: { "x-forwarded-for": ip },
      }));
      last = res.status;
      if (i < 60) expect(res.status).toBe(401); // no bearer → unauthorized, but counted
    }
    expect(last).toBe(429);
    // a different IP is unaffected
    const other = await manifestGET(new Request("http://localhost/api/kiosks/manifest?station_id=ABC123", {
      headers: { "x-forwarded-for": "198.51.100.7" },
    }));
    expect(other.status).toBe(401);
  });
});

/* ── D14: integration health probe in the alert sweep ──────────────────── */

describe("D14 — runAlertSweep integration health", () => {
  it("emits a warning for a degraded provider", async () => {
    healthMock.mockResolvedValueOnce({ provider: "fakeprov", status: "degraded", detail: "check failed", checkedAt: "", latencyMs: 5 });
    const summary = await runAlertSweep(dbHolder.db as never);
    expect(summary.checks["integration_health"]).toMatchObject({ status: "ok", matched: 1, emitted: 1 });
    await vi.waitFor(() => expect(alertStaffSpy).toHaveBeenCalled(), { timeout: 2000 });
    expect(String(alertStaffSpy.mock.calls.at(-1)?.[2])).toContain("integrations.health provider=fakeprov");
  });

  it("skips unconfigured providers without emitting", async () => {
    healthMock.mockResolvedValue({ provider: "fakeprov", status: "unconfigured", detail: "", checkedAt: "", latencyMs: null });
    const summary = await runAlertSweep(dbHolder.db as never);
    expect(summary.checks["integration_health"]).toMatchObject({ status: "skipped" });
    // emitted 1 = phase 4.4 recovery.test_overdue (empty system_recovery_tests
    // = never tested → reminder-level alert). The integration probe itself
    // emits nothing. (reportError is the real impl here — not a spy.)
    expect(summary.emitted).toBe(1);
  });
});

/* ── D9: retention coverage ────────────────────────────────────────────── */

describe("D9 — retention policy covers high-volume telemetry", () => {
  const EXPECTED: Record<string, { days: number; timeColumn: string; file: string }> = {
    device_events: { days: 365, timeColumn: "occurred_at", file: "0001_init.sql" },
    kiosk_events: { days: 365, timeColumn: "received_at", file: "0015_kiosk_lifecycle.sql" },
    business_events: { days: 180, timeColumn: "occurred_at", file: "0025_business_events.sql" },
    inbound_emails: { days: 180, timeColumn: "created_at", file: "0022_inbound_emails.sql" },
    sms_messages: { days: 365, timeColumn: "created_at", file: "0012_sms.sql" },
    ad_events: { days: 365, timeColumn: "occurred_at", file: "0027_business_expansion.sql" },
    notification_jobs: { days: 90, timeColumn: "created_at", file: "0013_billing_sms_engine.sql" },
  };

  it("every new rule exists, is not preserved, and uses LONG windows for device logs", () => {
    for (const [table, e] of Object.entries(EXPECTED)) {
      const rule = getRetentionRule(table);
      expect(rule, table).not.toBeNull();
      expect(rule!.retentionDays).toBe(e.days);
      expect(rule!.timeColumn).toBe(e.timeColumn);
      expect(rule!.retentionDays).toBeGreaterThanOrEqual(90);
    }
    // device/kiosk event logs get the long window, never short
    expect(getRetentionRule("device_events")!.retentionDays).toBe(365);
    expect(getRetentionRule("kiosk_events")!.retentionDays).toBe(365);
    // notification_jobs only sweeps terminal failure states — 'sent' is the dedupe record
    const nj = getRetentionRule("notification_jobs")!;
    expect(nj.statusValues).toEqual(["failed", "cancelled"]);
  });

  it("rule columns actually exist in the migrations that create the tables", () => {
    for (const [table, e] of Object.entries(EXPECTED)) {
      const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", e.file), "utf8");
      expect(sql, `${table} table`).toContain(`create table`);
      expect(sql.toLowerCase(), `${table}.${e.timeColumn}`).toContain(e.timeColumn);
      const rule = getRetentionRule(table)!;
      if (rule.statusColumn) expect(sql.toLowerCase(), `${table}.${rule.statusColumn}`).toContain(rule.statusColumn);
    }
  });

  it("preserved denylist still blocks legal/financial tables", () => {
    for (const t of ["payments", "rentals", "support_tickets", "system_audit_events", "profiles"]) {
      expect(getRetentionRule(t)).toBeNull();
    }
    expect(RETENTION_POLICY.every((r) => !["payments", "rentals"].includes(r.table))).toBe(true);
  });
});

/* ── D12: KEK vars in secret registry ──────────────────────────────────── */

describe("D12 — DEVICE_CREDENTIAL_KEK in SECRET_REGISTRY", () => {
  it("registry contains KEK + KEK_PREVIOUS with rotation guidance", () => {
    const vars = SECRET_REGISTRY.map((s) => s.envVar);
    expect(vars).toContain("DEVICE_CREDENTIAL_KEK");
    expect(vars).toContain("DEVICE_CREDENTIAL_KEK_PREVIOUS");
    const kek = SECRET_REGISTRY.find((s) => s.envVar === "DEVICE_CREDENTIAL_KEK")!;
    expect(kek.purpose.toLowerCase()).toContain("credential");
    expect(kek.rotation).toContain("DEVICE_CREDENTIAL_KEK_PREVIOUS");
  });
});

/* ── D15/D8: CRON_ROUTES reflect reality ───────────────────────────────── */

describe("jobs.ts — cron route registry", () => {
  it("all five vercel.json cron routes are registered and record cron_runs", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(CRON_ROUTES).toHaveLength(vercel.crons.length);
    for (const c of vercel.crons) {
      const route = CRON_ROUTES.find((r) => r.path === c.path);
      expect(route, c.path).toBeDefined();
      expect(route!.schedule).toBe(c.schedule);
      expect(route!.recordsCronRuns).toBe(true);
    }
    expect(CRON_ROUTES.map((r) => r.path)).toContain("/api/cron/retention");
  });
});
