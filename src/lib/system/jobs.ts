import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";
import { assertApprovedOrRequest, systemAudit, type SystemActor } from "./audit";
import { nextCronRun } from "./cron-schedule";
import { pausedJobSet } from "./job-controls";

/**
 * Queue/worker visibility for the system console. All numbers come from real
 * tables — nothing is simulated. Pause/resume IS supported for vercel.json
 * cron jobs via the `jobs.paused` app setting (Phase 4.4, job-controls.ts);
 * queue workers and provider webhooks are not pausable here.
 */

/** Vercel cron entries (vercel.json) → the cron_runs job names each route records. */
export const CRON_ROUTES: readonly { path: string; schedule: string; jobs: readonly string[]; recordsCronRuns: boolean }[] = [
  { path: "/api/cron/rentals", schedule: "0 12 * * *", jobs: ["rentals", "sms", "fleet", "entitlements", "ledgers"], recordsCronRuns: true },
  { path: "/api/cron/inbound", schedule: "0 13 * * *", jobs: ["inbound"], recordsCronRuns: true },
  { path: "/api/cron/uptime", schedule: "0 14 * * *", jobs: ["uptime"], recordsCronRuns: true }, // recordCron since Phase 2.7
  { path: "/api/cron/analytics", schedule: "30 14 * * *", jobs: ["analytics"], recordsCronRuns: true }, // recordCron since Phase 2.7
  { path: "/api/cron/retention", schedule: "0 4 * * *", jobs: ["retention"], recordsCronRuns: true }, // recordCron since Phase 2.7
];

export type QueueSummary = {
  name: string;
  table: string;
  description: string;
  counts: Record<string, number>;
  pending: number | null;
  oldestPendingAt: string | null;
  failures24h: number | null;
};

export type JobDependency = {
  name: string;
  /** Env-var presence / client-configured check ONLY — not a live probe. */
  configured: boolean | null;
  detail: string;
};

export type CronActivity = {
  at: string;
  ok: boolean;
  source: "cron_runs" | "audit";
  label: string;
};

export type CronJobStatus = {
  job: string;
  route: string;
  schedule: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  runs24h: number;
  failures24h: number;
  recordsCronRuns: boolean;
  /** Computed next fire time (UTC) from the cron expression; null = unknown. */
  nextRunAt: string | null;
  /** True when the job name is in the jobs.paused app setting. */
  paused: boolean;
  /** Latest trace_spans duration for cron.<job>; null when no span exists. */
  runtimeMs: number | null;
  /** Env-presence dependency checks — honestly labeled, never live probes. */
  dependencies: JobDependency[];
  /** Recent cron_runs rows + pause/resume audit events, newest first. */
  recentActivity: CronActivity[];
};

export type FailedOutboxEmail = {
  id: string;
  createdAt: string;
  sender: string | null;
  error: string | null;
};

export type SystemJobsReport = {
  configured: boolean;
  queues: QueueSummary[];
  cron: CronJobStatus[];
  observability: {
    errorEvents24h: number | null;
    openErrorIssues: number | null;
  };
  failedEmails: FailedOutboxEmail[];
  controls: {
    pauseResume: string;
    note: string;
  };
};

const DAY_MS = 24 * 3600_000;
const sinceIso = () => new Date(Date.now() - DAY_MS).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Filterable = any;

async function headCount(db: SupabaseClient, table: string, apply?: (q: Filterable) => Filterable): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

const num = (v: number | null) => v ?? 0;

/** Full jobs/queues report. Read-only; safe to call on every page load. */
export async function getSystemJobs(db: SupabaseClient | null): Promise<SystemJobsReport> {
  const empty: SystemJobsReport = {
    configured: false, queues: [], cron: [], observability: { errorEvents24h: null, openErrorIssues: null },
    failedEmails: [],
    controls: { pauseResume: "supported", note: "Cron pause/resume via the jobs.paused app setting (high-risk: step-up elevation + audit; breakglass needs an approved change request). Cron routes check the flag each run and record a skipped cron_runs row. Financial/settlement jobs are code-denylisted. Queue workers and provider webhooks are not pausable here." },
  };
  if (!db) return empty;

  const since = sinceIso();
  const cronJobNames = [...new Set(CRON_ROUTES.flatMap((r) => r.jobs))];
  const [
    outQueued, outSent, outFailed, outOldest,
    jobQueued, jobProcessing, jobDone, jobDead, jobOldest,
    notifQueued, notifSending, notifSent, notifFailed, notifCancelled, notifOldest,
    cronRows, paused, spanRows, auditRows, errEvents24, openIssues,
  ] = await Promise.all([
    headCount(db, "email_outbox", (q) => q.eq("status", "queued")),
    headCount(db, "email_outbox", (q) => q.eq("status", "sent")),
    headCount(db, "email_outbox", (q) => q.eq("status", "failed")),
    oldestAt(db, "email_outbox", "created_at", (q) => q.eq("status", "queued")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "queued")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "processing")),
    headCount(db, "inbound_jobs", (q) => q.eq("status", "done")),
    // NOTE: the worker only ever writes queued/processing/done/dead — 'failed'
    // is in the CHECK constraint but never set, so it is not counted (D15).
    headCount(db, "inbound_jobs", (q) => q.eq("status", "dead")),
    oldestAt(db, "inbound_jobs", "run_after", (q) => q.eq("status", "queued")),
    headCount(db, "notification_jobs", (q) => q.eq("status", "queued")),
    headCount(db, "notification_jobs", (q) => q.eq("status", "sending")),
    headCount(db, "notification_jobs", (q) => q.eq("status", "sent")),
    headCount(db, "notification_jobs", (q) => q.eq("status", "failed")),
    headCount(db, "notification_jobs", (q) => q.eq("status", "cancelled")),
    oldestAt(db, "notification_jobs", "due_at", (q) => q.eq("status", "queued")),
    db.from("cron_runs").select("job,ok,ran_at,detail").order("ran_at", { ascending: false }).limit(300),
    pausedJobSet(db),
    // Latest trace span per cron.<job> for runtime (cron_runs has no duration column).
    db.from("trace_spans").select("name,duration_ms,created_at").in("name", cronJobNames.map((j) => `cron.${j}`)).order("created_at", { ascending: false }).limit(200),
    // Pause/resume audit events are written against resource cron_job:<name>.
    db.from("system_audit_events").select("action,resource,created_at").in("resource", cronJobNames.map((j) => `cron_job:${j}`)).order("created_at", { ascending: false }).limit(100),
    headCount(db, "error_events", (q) => q.gte("occurred_at", since)),
    headCount(db, "error_issues", (q) => q.in("status", ["new", "investigating", "assigned", "regressed"])),
  ]);

  // Latest run + 24h stats per recorded cron job.
  const runs = ((cronRows as { data?: { job: string; ok: boolean; ran_at: string; detail?: unknown }[] | null; error?: unknown })?.data ?? []) as { job: string; ok: boolean; ran_at: string; detail?: unknown }[];
  const byJob = new Map<string, { last: { ok: boolean; ran_at: string } | null; runs24h: number; failures24h: number; recent: CronActivity[] }>();
  for (const r of runs) {
    const e = byJob.get(r.job) ?? { last: null, runs24h: 0, failures24h: 0, recent: [] };
    if (!e.last) e.last = r;
    if (r.ran_at >= since) {
      e.runs24h += 1;
      if (!r.ok) e.failures24h += 1;
    }
    if (e.recent.length < 5) {
      const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : null;
      const err = typeof detail?.error === "string" ? detail.error.slice(0, 120) : null;
      const pausedRun = detail?.paused === true;
      e.recent.push({
        at: r.ran_at, ok: r.ok, source: "cron_runs",
        label: pausedRun ? "skipped (paused)" : r.ok ? "ok" : `failed${err ? `: ${err}` : ""}`,
      });
    }
    byJob.set(r.job, e);
  }

  // Latest span duration per cron.<job>.
  const runtimeByJob = new Map<string, number>();
  const spanData = ((spanRows as { data?: { name: string; duration_ms: number }[] | null })?.data ?? []) as { name: string; duration_ms: number }[];
  for (const s of spanData) {
    const job = s.name.startsWith("cron.") ? s.name.slice(5) : s.name;
    if (!runtimeByJob.has(job)) runtimeByJob.set(job, s.duration_ms);
  }

  // Audit events for cron_job:<name> resources (pause/resume), grouped per job.
  const auditByJob = new Map<string, CronActivity[]>();
  const auditData = ((auditRows as { data?: { action: string; resource: string; created_at: string }[] | null })?.data ?? []) as { action: string; resource: string; created_at: string }[];
  for (const a of auditData) {
    const job = a.resource.startsWith("cron_job:") ? a.resource.slice(9) : a.resource;
    const list = auditByJob.get(job) ?? [];
    if (list.length < 5) list.push({ at: a.created_at, ok: true, source: "audit", label: a.action });
    auditByJob.set(job, list);
  }

  const cron: CronJobStatus[] = CRON_ROUTES.flatMap((route) =>
    route.jobs.map((job) => {
      const e = byJob.get(job);
      const next = nextCronRun(route.schedule);
      const recent = [...(e?.recent ?? []), ...(auditByJob.get(job) ?? [])]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 6);
      return {
        job, route: route.path, schedule: route.schedule,
        lastRunAt: e?.last?.ran_at ?? null,
        lastOk: e?.last ? e.last.ok : null,
        runs24h: e?.runs24h ?? 0,
        failures24h: e?.failures24h ?? 0,
        recordsCronRuns: route.recordsCronRuns,
        nextRunAt: next ? next.toISOString() : null,
        paused: paused.has(job.toLowerCase()),
        runtimeMs: runtimeByJob.get(job) ?? null,
        dependencies: jobDependencies(job, Boolean(db)),
        recentActivity: recent,
      };
    }),
  );

  // Recent failed outbox rows for the retry UI — no recipient addresses (PII).
  let failedEmails: FailedOutboxEmail[] = [];
  try {
    const { data } = await db
      .from("email_outbox")
      .select("id,created_at,sender,error")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(15);
    failedEmails = ((data ?? []) as { id: string; created_at: string; sender: string | null; error: string | null }[]).map((r) => ({
      id: r.id, createdAt: r.created_at, sender: r.sender, error: scrub(String(r.error ?? ""), 160) || null,
    }));
  } catch { /* best-effort */ }

  return {
    configured: true,
    queues: [
      {
        name: "email_outbox", table: "email_outbox",
        description: "Helpdesk/customer email queue — flushed by the mailer (Brevo/Resend). 'failed' rows can be requeued.",
        counts: { queued: num(outQueued), sent: num(outSent), failed: num(outFailed) },
        pending: outQueued, oldestPendingAt: outOldest, failures24h: null,
      },
      {
        name: "inbound_jobs", table: "inbound_jobs",
        description: "Durable inbound-email job queue — claimed by /api/cron/inbound with backoff + dead-letter.",
        counts: { queued: num(jobQueued), processing: num(jobProcessing), done: num(jobDone), dead: num(jobDead) },
        pending: (jobQueued ?? 0) + (jobProcessing ?? 0), oldestPendingAt: jobOldest,
        failures24h: num(jobDead),
      },
      {
        name: "notification_jobs", table: "notification_jobs",
        description: "Rental SMS schedule engine — durable per-rental dedupe, claimed by the rentals cron sweep.",
        counts: { queued: num(notifQueued), sending: num(notifSending), sent: num(notifSent), failed: num(notifFailed), cancelled: num(notifCancelled) },
        pending: (notifQueued ?? 0) + (notifSending ?? 0), oldestPendingAt: notifOldest, failures24h: num(notifFailed),
      },
    ],
    cron,
    observability: { errorEvents24h: errEvents24, openErrorIssues: openIssues },
    failedEmails,
    controls: empty.controls,
  };
}

async function oldestAt(db: SupabaseClient, table: string, column: string, apply?: (q: Filterable) => Filterable): Promise<string | null> {
  try {
    let q = db.from(table).select(column).order(column, { ascending: true }).limit(1);
    if (apply) q = apply(q);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return (data as unknown as Record<string, unknown>)[column] as string | null;
  } catch {
    return null;
  }
}

/* ── Dependency health (env presence only — never live probes) ──────────── */

const envPresent = (...keys: string[]) => keys.some((k) => Boolean(process.env[k]?.trim()));
const supabaseDep = (configured: boolean): JobDependency => ({
  name: "supabase", configured, detail: "service client configured",
});

/**
 * Honest dependency checks per cron job: env-var PRESENCE only (a missing var
 * means the job's external calls will fail; a present var is NOT proof the
 * provider account works). `configured: null` = not applicable/unknown.
 */
export function jobDependencies(job: string, dbConfigured: boolean): JobDependency[] {
  const sb = supabaseDep(dbConfigured);
  const mailer: JobDependency = {
    name: "mailer", configured: envPresent("RESEND_API_KEY", "BREVO_API_KEY"),
    detail: "RESEND_API_KEY or BREVO_API_KEY present (env check only)",
  };
  const twilio: JobDependency = {
    name: "twilio", configured: envPresent("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"),
    detail: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN present (env check only)",
  };
  switch (job) {
    case "rentals": return [sb, mailer, twilio];
    case "sms": return [sb, twilio];
    case "inbound": return [
      sb,
      { name: "email_inbound_secret", configured: envPresent("EMAIL_INBOUND_SECRET"), detail: "webhook enqueue secret — worker drains the queue regardless" },
      mailer,
    ];
    case "fleet": return [sb];
    case "entitlements": return [sb];
    case "ledgers": return [sb, mailer];
    case "uptime": return [sb, { name: "external_targets", configured: null, detail: "probes public URLs — no env dependency" }];
    case "analytics": return [sb];
    case "retention": return [sb];
    default: return [sb];
  }
}

/* ── Operator controls ─────────────────────────────────────────────────── */

export type RetryResult =
  | { ok: true; emailId: string; changeRequestId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Requeues a failed email_outbox row (status failed → queued). The next
 * flushOutbox pass sends it through the configured mailer. Audited; goes
 * through assertApprovedOrRequest so breakglass/high-risk paths still gate.
 */
export async function retryOutboxEmail(
  db: SupabaseClient,
  actor: SystemActor,
  emailId: string,
  justification?: string,
): Promise<RetryResult> {
  const { data: row, error } = await db
    .from("email_outbox")
    .select("id,status,created_at")
    .eq("id", emailId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!row) return { ok: false, status: 404, error: "Outbox email not found" };
  const r = row as { id: string; status: string; created_at: string };
  if (r.status !== "failed") {
    return { ok: false, status: 409, error: `not_retryable`, };
  }

  const action = `jobs.email_outbox.retry:${r.id}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: justification ?? `Requeue failed email_outbox row ${r.id} (created ${r.created_at}) for the next mailer flush.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "jobs.email_retry_pending", resource: `email_outbox:${r.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required" };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("email_outbox")
    .update({ status: "queued", error: null })
    .eq("id", r.id)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  if (!updated) return { ok: false, status: 409, error: "state_changed" };

  await systemAudit(db, {
    actor, action: "jobs.email_retried", resource: `email_outbox:${r.id}`,
    detail: { changeRequestId: approval.changeRequestId },
  });
  return { ok: true, emailId: r.id, changeRequestId: approval.changeRequestId };
}
