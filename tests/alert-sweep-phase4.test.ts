import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* reportError is the single emit mechanism — spy on it (same pattern as
 * alert-emitters.test.ts). */
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/observability")>();
  return { ...orig, reportError };
});

import { runAlertSweep } from "@/lib/system/alert-sweep";

/* ── Stateful in-memory Supabase stub (QB pattern from alert-emitters) ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
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
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) <= 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ created_at: new Date().toISOString(), ...item });
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

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient };
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const MIN_AGO = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const emissions = () =>
  reportError.mock.calls.map((c) => {
    const err = c[0] as Error;
    const ctx = (c[1] ?? {}) as { severity?: string; route?: string };
    return { message: err?.message ?? String(c[0]), severity: ctx.severity, route: ctx.route };
  });
const msgs = (needle: string) => emissions().map((e) => e.message).filter((m) => m.includes(needle));

beforeEach(() => reportError.mockClear());

/* ── Phase 4.1 sweep probes ──────────────────────────────────────────────── */

describe("runAlertSweep — phase 4.1 probes", () => {
  it("deployment.failed: alerts per failed request touched within 24h", async () => {
    const { db } = fakeDb({
      system_deployment_requests: [
        { id: "dep-1", action: "deploy", status: "failed", created_at: HOURS_AGO(30), decided_at: HOURS_AGO(2) }, // decided recently → alert
        { id: "dep-2", action: "rollback", status: "failed", created_at: HOURS_AGO(2), decided_at: null }, // created recently → alert
        { id: "dep-3", action: "deploy", status: "failed", created_at: HOURS_AGO(72), decided_at: HOURS_AGO(48) }, // stale → no
        { id: "dep-4", action: "deploy", status: "executed", created_at: HOURS_AGO(1), decided_at: null }, // not failed → no
        { id: "dep-5", action: "deploy", status: "pending", created_at: HOURS_AGO(1), decided_at: null },
      ],
    });
    const s = await runAlertSweep(db);
    expect(s.checks.deployment_failed).toMatchObject({ status: "ok", emitted: 2 });
    expect(msgs("deployment.failed").some((m) => m.includes("request=dep-1"))).toBe(true);
    expect(msgs("deployment.failed").some((m) => m.includes("request=dep-2"))).toBe(true);
    expect(msgs("deployment.failed").some((m) => m.includes("dep-3") || m.includes("dep-4") || m.includes("dep-5"))).toBe(false);
  });

  it("deployment.health_degraded: one alert per distinct audit resource", async () => {
    const { db } = fakeDb({
      system_audit_events: [
        { action: "deployment.health_degraded", resource: "health_profile:www", created_at: HOURS_AGO(3) },
        { action: "deployment.health_degraded", resource: "health_profile:www", created_at: HOURS_AGO(1) }, // dup target
        { action: "deployment.health_degraded", resource: "health_profile:api", created_at: HOURS_AGO(5) },
        { action: "deployment.health_degraded", resource: "health_profile:old", created_at: HOURS_AGO(48) }, // stale
        { action: "deployment.health_profile", resource: "health_profile:ok", created_at: HOURS_AGO(1) }, // healthy run — no alert
      ],
    });
    const s = await runAlertSweep(db);
    expect(s.checks.deployment_health_degraded).toMatchObject({ status: "ok", emitted: 2 });
    expect(msgs("deployment.health_degraded").filter((m) => m.includes("target=health_profile:www"))).toHaveLength(1);
    expect(msgs("deployment.health_degraded").some((m) => m.includes("target=health_profile:api"))).toBe(true);
    expect(msgs("deployment.health_degraded").some((m) => m.includes("old") || m.includes("health_profile:ok"))).toBe(false);
  });

  it("webhook.failures: dead/failed inbound_jobs within 24h only", async () => {
    const { db } = fakeDb({
      inbound_jobs: [
        { id: "job-1", status: "dead", created_at: HOURS_AGO(30), processed_at: HOURS_AGO(1) }, // processed recently → alert
        { id: "job-2", status: "failed", created_at: HOURS_AGO(2), processed_at: null }, // created recently → alert
        { id: "job-3", status: "dead", created_at: HOURS_AGO(72), processed_at: HOURS_AGO(50) }, // stale → no
        { id: "job-4", status: "done", created_at: HOURS_AGO(1), processed_at: HOURS_AGO(1) },
        { id: "job-5", status: "queued", created_at: HOURS_AGO(1), processed_at: null },
      ],
    });
    const s = await runAlertSweep(db);
    expect(s.checks.webhook_inbound_failures).toMatchObject({ status: "ok", emitted: 2 });
    expect(msgs("webhook.failures").some((m) => m.includes("job=job-1") && m.includes("status=dead"))).toBe(true);
    expect(msgs("webhook.failures").some((m) => m.includes("job=job-2"))).toBe(true);
    expect(msgs("webhook.failures").some((m) => m.includes("job-3") || m.includes("job-4") || m.includes("job-5"))).toBe(false);
  });

  it("jobs.failed: cron failures dedupe per job; outbox + notification rows alert per id", async () => {
    const { db } = fakeDb({
      cron_runs: [
        { job: "rentals", ok: false, ran_at: MIN_AGO(30) },
        { job: "rentals", ok: false, ran_at: MIN_AGO(10) }, // same job → one alert
        { job: "uptime", ok: false, ran_at: MIN_AGO(20) },
        { job: "retention", ok: true, ran_at: MIN_AGO(20) },
        { job: "analytics", ok: false, ran_at: HOURS_AGO(30) }, // stale → no
      ],
      email_outbox: [
        { id: "mail-1", status: "failed", created_at: HOURS_AGO(2) },
        { id: "mail-2", status: "queued", created_at: HOURS_AGO(2) },
        { id: "mail-3", status: "failed", created_at: HOURS_AGO(48) }, // stale → no
      ],
      notification_jobs: [
        { id: "notif-1", status: "failed", created_at: HOURS_AGO(3) },
        { id: "notif-2", status: "sent", created_at: HOURS_AGO(3) },
      ],
    });
    const s = await runAlertSweep(db);
    expect(s.checks.cron_job_failures).toMatchObject({ status: "ok", emitted: 2 }); // rentals + uptime
    expect(s.checks.email_outbox_failures).toMatchObject({ status: "ok", emitted: 1 });
    expect(s.checks.notification_job_failures).toMatchObject({ status: "ok", emitted: 1 });

    const cronMsgs = msgs("jobs.failed").filter((m) => m.includes("source=cron_runs"));
    expect(cronMsgs.filter((m) => m.includes("job=rentals"))).toHaveLength(1);
    expect(cronMsgs.some((m) => m.includes("job=uptime"))).toBe(true);
    expect(msgs("jobs.failed").some((m) => m.includes("email_outbox=mail-1"))).toBe(true);
    expect(msgs("jobs.failed").some((m) => m.includes("notification_job=notif-1"))).toBe(true);
    expect(msgs("jobs.failed").some((m) => m.includes("mail-2") || m.includes("mail-3") || m.includes("notif-2") || m.includes("analytics"))).toBe(false);
  });

  it("device.credential_abuse: >=5 unexplained rejections per device; dedicated reasons excluded", async () => {
    const rejected = (device: string | null, uid: string, reason: string, minsAgo: number): Row => ({
      device_id: device,
      detail: { reason, device_uid: uid },
      result: "rejected",
      received_at: MIN_AGO(minsAgo),
    });
    const { db } = fakeDb({
      system_device_messages: [
        // dev-abuse: 6 bad_signature → alert
        ...Array.from({ length: 6 }, (_, i) => rejected("dev-abuse", "kiosk-a", "bad_signature", i + 1)),
        // dev-few: 4 rejections → below threshold
        ...Array.from({ length: 4 }, (_, i) => rejected("dev-few", "kiosk-b", "bad_signature", i + 1)),
        // dev-dedicated: 10 credential_revoked → excluded (own emitter)
        ...Array.from({ length: 10 }, (_, i) => rejected("dev-dedicated", "kiosk-c", "credential_revoked", i + 1)),
        // unattributed (null device_id, no uid): 5 device_unknown → alert
        ...Array.from({ length: 5 }, (_, i) => ({ device_id: null, detail: { reason: "device_unknown" }, result: "rejected", received_at: MIN_AGO(i + 1) })),
        // stale rejections don't count (probe window is 24h — use 25h)
        rejected("dev-old", "kiosk-old", "bad_signature", 25 * 60),
        rejected("dev-old", "kiosk-old", "bad_signature", 25 * 60 + 5),
      ],
    });
    const s = await runAlertSweep(db);
    expect(s.checks.device_credential_abuse).toMatchObject({ status: "ok" });
    expect(s.checks.device_credential_abuse.status === "ok" && s.checks.device_credential_abuse.emitted).toBe(2);
    expect(msgs("device.credential_abuse").some((m) => m.includes("device=dev-abuse"))).toBe(true);
    expect(msgs("device.credential_abuse").some((m) => m.includes("device=unattributed"))).toBe(true);
    expect(msgs("device.credential_abuse").some((m) => m.includes("dev-few") || m.includes("dev-dedicated") || m.includes("dev-old"))).toBe(false);
    // Stable message — no counts embedded (fingerprint dedup).
    for (const m of msgs("device.credential_abuse")) expect(m).not.toMatch(/count=|\d+ rejections/);
  });

  it("all new probes skip honestly when tables are missing", async () => {
    const db = { from: () => { throw new Error("relation does not exist"); } } as unknown as SupabaseClient;
    const s = await runAlertSweep(db);
    expect(s.ok).toBe(true);
    for (const name of [
      "deployment_failed", "deployment_health_degraded", "webhook_inbound_failures",
      "cron_job_failures", "email_outbox_failures", "notification_job_failures",
      "device_credential_abuse",
    ]) {
      expect(s.checks[name]).toMatchObject({ status: "skipped" });
    }
    expect(s.emitted).toBe(0);
  });
});
