import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { nextCronRun, parseCronExpression } from "@/lib/system/cron-schedule";
import { replayWebhookEvent, replayEligibility, MAX_REPLAYS_PER_JOB, WEBHOOK_SOURCES } from "@/lib/system/webhooks";
import { jobControlDenied, parsePausedJobsValue, pausedJobSet, setJobPaused, recordPausedRun, JOBS_PAUSED_KEY } from "@/lib/system/job-controls";
import { signatureVerification, relatedBusinessObject, replayEligibility as infraReplayEligibility } from "@/lib/system/webhook-inspector";
import { getSystemJobs, jobDependencies } from "@/lib/system/jobs";

/* ── Stateful Supabase stub (QB pattern from app-settings.test.ts) ──────── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  let seq = 0;

  class QB {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: unknown = null;
    private onConflict: string | null = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, opts?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.onConflict = opts?.onConflict ?? null; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    like(c: string, pattern: string) {
      const prefix = String(pattern).replace(/%$/, "");
      this.filters.push((r) => String(r[c] ?? "").startsWith(prefix));
      return this;
    }
    gte() { return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          const row = { id: `gen-${++seq}`, created_at: new Date().toISOString(), ...item };
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
      if (this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const conflictCol = this.onConflict ?? "key";
        const out: Row[] = [];
        for (const item of items) {
          const existing = rows.find((r) => eqv(r[conflictCol], item[conflictCol]));
          if (existing) { Object.assign(existing, item); out.push(existing); }
          else { const row = { created_at: new Date().toISOString(), ...item }; rows.push(row); out.push(row); }
        }
        return { data: out, error: null };
      }
      let out = rows.filter(match);
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    private finish() { return this.run(); }
    single() {
      const { data, error } = this.finish();
      const arr = data as Row[];
      return Promise.resolve({ data: arr[0] ?? null, error: arr.length ? null : { message: "not found" } });
    }
    maybeSingle() {
      const { data } = this.finish();
      const arr = data as Row[];
      return Promise.resolve({ data: arr[0] ?? null, error: null });
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.finish()).then(resolve, reject);
    }
  }
  const db = { from: (t: string) => new QB(t), __tables: tables };
  return db as unknown as SupabaseClient & { __tables: Record<string, Row[]> };
}

const actor = (role: string) => ({ id: "u-1", role });
const user = { id: "u-1" } as SessionUser;
const freshElevation = () => ({
  id: "e-1", profile_id: "u-1", method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null,
});

/* ── cron-schedule ─────────────────────────────────────────────────────── */

describe("nextCronRun", () => {
  const from = new Date("2026-03-10T11:00:00Z"); // a Tuesday

  it("daily schedules from vercel.json", () => {
    expect(nextCronRun("0 12 * * *", from)?.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    expect(nextCronRun("0 13 * * *", from)?.toISOString()).toBe("2026-03-10T13:00:00.000Z");
    expect(nextCronRun("30 14 * * *", from)?.toISOString()).toBe("2026-03-10T14:30:00.000Z");
    expect(nextCronRun("0 4 * * *", from)?.toISOString()).toBe("2026-03-11T04:00:00.000Z");
  });

  it("steps to next day when today's slot passed", () => {
    expect(nextCronRun("0 10 * * *", from)?.toISOString()).toBe("2026-03-11T10:00:00.000Z");
  });

  it("handles steps, lists, ranges and dow", () => {
    // every 15 min
    expect(nextCronRun("*/15 * * * *", from)?.toISOString()).toBe("2026-03-10T11:15:00.000Z");
    // weekdays only at 09:00 — 2026-03-10 is Tuesday
    expect(nextCronRun("0 9 * * 1-5", from)?.toISOString()).toBe("2026-03-11T09:00:00.000Z");
    // Sunday (dow 0 or 7)
    expect(nextCronRun("0 0 * * 0", from)?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(nextCronRun("0 0 * * 7", from)?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    // monthly on the 1st
    expect(nextCronRun("0 0 1 * *", from)?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("returns null for invalid or impossible schedules", () => {
    expect(nextCronRun("not a cron", from)).toBeNull();
    expect(nextCronRun("61 * * * *", from)).toBeNull();
    expect(nextCronRun("0 0 30 2 *", from)).toBeNull(); // Feb 30 never occurs
    expect(parseCronExpression("* * * *")).toBeNull();
  });
});

/* ── webhook replay ────────────────────────────────────────────────────── */

const deadJob = (over: Row = {}): Row => ({
  id: "job-1", kind: "email_message", status: "dead", attempts: 5, max_attempts: 5,
  payload: { from: "a@b.c", subject: "hi", text: "body", messageId: "<m1@x>", recipients: ["support@zapnivo.com"] },
  ...over,
});

describe("replayWebhookEvent — authorization & exclusions", () => {
  it("stripe_events → 403 forbidden_financial (payment exclusion)", async () => {
    const db = fakeDb();
    const r = await replayWebhookEvent(db, actor("sysadmin"), "stripe_events", "evt_1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe("forbidden_financial");
    }
    // audited denial
    expect((db as never as { __tables: Record<string, Row[]> }).__tables.system_audit_events.length).toBeGreaterThan(0);
  });

  it("non-inbound_jobs sources → 409 replay_unsupported", async () => {
    for (const src of ["inbound_emails", "sms_messages", "kiosk_events"] as const) {
      const db = fakeDb();
      const r = await replayWebhookEvent(db, actor("sysadmin"), src, "x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(409);
    }
  });

  it("all WEBHOOK_SOURCES except inbound_jobs are non-replayable", () => {
    for (const s of WEBHOOK_SOURCES) {
      if (s === "inbound_jobs") continue;
      const row = { id: "x", status: "failed" };
      expect(replayEligibility(s, row).eligible).toBe(false);
    }
  });

  it("status/kind gates", async () => {
    const done = fakeDb({ inbound_jobs: [deadJob({ status: "done" })] });
    const r1 = await replayWebhookEvent(done, actor("sysadmin"), "inbound_jobs", "job-1");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe("not_replayable");

    const weird = fakeDb({ inbound_jobs: [deadJob({ kind: "sms_alert" })] });
    const r2 = await replayWebhookEvent(weird, actor("sysadmin"), "inbound_jobs", "job-1");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("kind_not_replayable");
  });

  it("breakglass role → 202 approval_required, NO new job inserted", async () => {
    const db = fakeDb({ inbound_jobs: [deadJob()] });
    const r = await replayWebhookEvent(db, actor("breakglass"), "inbound_jobs", "job-1", "please retry");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(202);
    const tables = (db as never as { __tables: Record<string, Row[]> }).__tables;
    expect(tables.inbound_jobs).toHaveLength(1); // original only — no attempt created
    expect(tables.system_change_requests.length).toBe(1);
  });
});

describe("replayWebhookEvent — new attempt record (original untouched)", () => {
  it("inserts a NEW queued row; original stays dead; payload carries provenance", async () => {
    const db = fakeDb({ inbound_jobs: [deadJob()] });
    const r = await replayWebhookEvent(db, actor("sysadmin"), "inbound_jobs", "job-1", "root cause fixed");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tables = (db as never as { __tables: Record<string, Row[]> }).__tables;
    expect(tables.inbound_jobs).toHaveLength(2);
    const orig = tables.inbound_jobs.find((j) => j.id === "job-1")!;
    expect(orig.status).toBe("dead"); // NEVER mutated
    const attempt = tables.inbound_jobs.find((j) => j.id === r.jobId)!;
    expect(attempt.status).toBe("queued");
    expect(attempt.attempts).toBe(0);
    expect(attempt.message_id).toBe("replay:job-1:1");
    const payload = attempt.payload as Row;
    expect(payload.replayedFrom).toBe("job-1");
    expect(payload.replayAttempt).toBe(1);
    expect(payload.messageId).toBe("<m1@x>"); // original Message-ID preserved → processor dedupe intact
    // audit webhook.replayed with actor + reason
    const audits = tables.system_audit_events.filter((a) => a.action === "webhook.replayed");
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe("u-1");
    expect((audits[0].detail as Row).justification).toBe("root cause fixed");
    expect((audits[0].detail as Row).replayOf).toBe("job-1");
  });

  it("second replay gets suffix :2; cap at MAX_REPLAYS_PER_JOB", async () => {
    const priors = Array.from({ length: MAX_REPLAYS_PER_JOB }, (_, i) => ({
      id: `rp-${i}`, message_id: `replay:job-1:${i + 1}`, status: "done",
    }));
    const db = fakeDb({ inbound_jobs: [deadJob(), ...priors] });
    const r = await replayWebhookEvent(db, actor("engineer"), "inbound_jobs", "job-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("replay_limit");
    expect((db as never as { __tables: Record<string, Row[]> }).__tables.inbound_jobs).toHaveLength(1 + MAX_REPLAYS_PER_JOB);
  });
});

/* ── job controls ──────────────────────────────────────────────────────── */

describe("jobControlDenied / parsePausedJobsValue", () => {
  it("financial jobs denied for pause/resume/retry; retention denied for retry only", () => {
    expect(jobControlDenied("ledgers", "pause")).toBeTruthy();
    expect(jobControlDenied("stripe_settlement", "resume")).toBeTruthy();
    expect(jobControlDenied("payout_batch", "retry")).toBeTruthy();
    expect(jobControlDenied("retention", "retry")).toBeTruthy();
    expect(jobControlDenied("retention", "pause")).toBeNull(); // pause is the SAFE control for destructive jobs
    expect(jobControlDenied("inbound", "pause")).toBeNull();
    expect(jobControlDenied("uptime", "resume")).toBeNull();
  });

  it("parses comma-separated paused list case-insensitively", () => {
    expect([...parsePausedJobsValue("Inbound, UPTIME ,,sms")].sort()).toEqual(["inbound", "sms", "uptime"]);
    expect(parsePausedJobsValue("").size).toBe(0);
    expect(parsePausedJobsValue(null).size).toBe(0);
    expect(parsePausedJobsValue(["a"]).size).toBe(0);
  });
});

describe("pausedJobSet", () => {
  it("reads jobs.paused setting; empty/unavailable → empty set", async () => {
    const db = fakeDb({ system_app_settings: [{ key: JOBS_PAUSED_KEY, value: "inbound, uptime" }] });
    const s = await pausedJobSet(db);
    expect(s.has("inbound")).toBe(true);
    expect(s.has("uptime")).toBe(true);
    expect(s.has("rentals")).toBe(false);
    const empty = await pausedJobSet(fakeDb());
    expect(empty.size).toBe(0);
    expect((await pausedJobSet(null)).size).toBe(0);
  });
});

describe("setJobPaused", () => {
  const KNOWN = ["rentals", "sms", "fleet", "entitlements", "ledgers", "inbound", "uptime", "analytics", "retention"];

  it("unknown job → 400; denylisted job → 403 before any write", async () => {
    const db = fakeDb();
    const r1 = await setJobPaused(db, actor("sysadmin"), user, { job: "bogus", paused: true, knownJobs: KNOWN });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe(400);
    const r2 = await setJobPaused(db, actor("sysadmin"), user, { job: "ledgers", paused: true, knownJobs: KNOWN });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.status).toBe(403);
    expect((db as never as { __tables: Record<string, Row[]> }).__tables.system_app_settings ?? []).toHaveLength(0);
  });

  it("high-risk setting requires step-up elevation → 403 step_up_required", async () => {
    const db = fakeDb();
    const r = await setJobPaused(db, actor("sysadmin"), user, { job: "inbound", paused: true, knownJobs: KNOWN });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.code).toBe("step_up_required");
    }
  });

  it("with fresh elevation: pauses job, upserts jobs.paused, audits jobs.paused", async () => {
    const db = fakeDb({ system_elevations: [freshElevation()] });
    const r = await setJobPaused(db, actor("sysadmin"), user, { job: "Inbound", paused: true, justification: "provider outage", knownJobs: KNOWN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tables = (db as never as { __tables: Record<string, Row[]> }).__tables;
    const setting = tables.system_app_settings.find((s) => s.key === JOBS_PAUSED_KEY);
    expect(setting?.value).toBe("inbound");
    const audits = tables.system_audit_events.filter((a) => a.action === "jobs.paused");
    expect(audits).toHaveLength(1);
    expect(audits[0].resource).toBe("cron_job:inbound");
    expect((audits[0].detail as Row).justification).toBe("provider outage");
    // resume removes it
    const r2 = await setJobPaused(db, actor("sysadmin"), user, { job: "inbound", paused: false, knownJobs: KNOWN });
    expect(r2.ok).toBe(true);
    expect(tables.system_app_settings.find((s) => s.key === JOBS_PAUSED_KEY)?.value).toBe("");
    expect(tables.system_audit_events.filter((a) => a.action === "jobs.resumed")).toHaveLength(1);
  });
});

describe("recordPausedRun", () => {
  it("writes a skipped cron_runs row and never throws", async () => {
    const db = fakeDb();
    const r = await recordPausedRun(db, "uptime");
    expect(r.ok).toBe(true);
    expect(r.detail.paused).toBe(true);
    const tables = (db as never as { __tables: Record<string, Row[]> }).__tables;
    expect(tables.cron_runs[0].job).toBe("uptime");
    expect((tables.cron_runs[0].detail as Row).paused).toBe(true);
  });
});

/* ── inspector enrichment + job report ─────────────────────────────────── */

describe("signatureVerification / relatedBusinessObject", () => {
  it("honest per-source strings", () => {
    expect(signatureVerification("stripe_events", {}).length).toBeGreaterThan(10);
    expect(signatureVerification("inbound_emails", { auth_method: "spf", dmarc_result: "pass", spf_result: "pass", dkim_result: "none" })).toContain("dmarc=pass");
    expect(signatureVerification("email_outbox", {})).toContain("n/a");
    expect(signatureVerification("unknown_source", {})).toBe("not recorded");
  });

  it("derives ticket refs from payload without exposing PII", () => {
    expect(relatedBusinessObject("inbound_jobs", {}, { subject: "Re: Z-1042 rental", inReplyTo: null })).toBe("support_ticket:Z-1042");
    expect(relatedBusinessObject("inbound_jobs", {}, { subject: "hello", replayedFrom: "abc12345-0000" })).toContain("replay of job abc12345");
    expect(relatedBusinessObject("stripe_events", { type: "checkout.session.completed" })).toBe("payment_event:checkout.session.completed");
    expect(relatedBusinessObject("email_outbox", {})).toBe("outbound_email");
    expect(relatedBusinessObject("inbound_jobs", {}, null)).toBe("inbound_email_job");
  });
});

describe("infra replayEligibility — financial explicit", () => {
  it("stripe_events reason mentions forbidden/financial", () => {
    const r = infraReplayEligibility("stripe_events", { id: "e1", status: "recorded" });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toMatch(/financial|forbidden/i);
  });
});

describe("getSystemJobs — cron enrichment", () => {
  it("includes nextRunAt, paused flag, dependencies, recentActivity", async () => {
    const db = fakeDb({
      cron_runs: [{ job: "inbound", ok: true, ran_at: new Date().toISOString(), detail: { claimed: 3 } }],
      system_app_settings: [{ key: JOBS_PAUSED_KEY, value: "uptime" }],
    });
    const report = await getSystemJobs(db);
    expect(report.configured).toBe(true);
    const inbound = report.cron.find((c) => c.job === "inbound");
    expect(inbound?.nextRunAt).toBeTruthy();
    expect(inbound?.paused).toBe(false);
    expect(inbound?.dependencies.length).toBeGreaterThan(0);
    expect(inbound?.recentActivity[0]?.source).toBe("cron_runs");
    const uptime = report.cron.find((c) => c.job === "uptime");
    expect(uptime?.paused).toBe(true);
    expect(report.controls.pauseResume).toBe("supported");
  });

  it("null db → honest empty report", async () => {
    const r = await getSystemJobs(null);
    expect(r.configured).toBe(false);
    expect(r.cron).toEqual([]);
  });
});

describe("jobDependencies", () => {
  it("labels env checks honestly", () => {
    const rentals = jobDependencies("rentals", true);
    expect(rentals.map((d) => d.name)).toContain("mailer");
    expect(rentals.find((d) => d.name === "supabase")?.configured).toBe(true);
    for (const d of rentals) expect(d.detail.length).toBeGreaterThan(0);
  });
});
