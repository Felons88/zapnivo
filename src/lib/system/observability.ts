import type { SupabaseClient } from "@supabase/supabase-js";
import { scrub } from "@/lib/observability";

/**
 * Observability read model for system.zapnivo.com.
 *
 * Sources (all real tables from migration 0026 + 0008):
 *  - error_events / error_issues  — grouped exceptions (fingerprint)
 *  - app_logs                     — structured log lines (already scrubbed at write;
 *                                   we re-scrub on read as defense in depth)
 *  - trace_spans                  — latency instrumentation where callers opted in
 *  - cron_runs                    — scheduled job outcomes
 *  - uptime_checks                — synthetic uptime probe results
 *  - incidents                    — open/closed incident records
 *
 * Everything here is read-only. Where instrumentation is absent the UI gets
 * honest zeros/empties — never fabricated data.
 */

export type ErrorSeverity = "error" | "critical" | "warning";
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export type ObservabilityOverview = {
  configured: boolean;
  errors24h: {
    total: number;
    bySeverity: Record<string, number>;
    byRuntime: Record<string, number>;
    openCriticalIssues: number;
  };
  logs24h: {
    total: number;
    byLevel: Record<string, number>;
    byService: { service: string; count: number }[];
  };
  traces24h: {
    spans: number;
    byService: { service: string; avgMs: number | null; p95Ms: number | null; errors: number }[];
  };
  crons: {
    jobs: { job: string; lastRunAt: string; lastOk: boolean; runs24h: number; failures24h: number }[];
    totalRuns24h: number;
    failures24h: number;
  };
  uptime: {
    targets: { url: string; ok: boolean; statusCode: number | null; latencyMs: number | null; checkedAt: string; checks24h: number; okPct24h: number | null }[];
    overallOkPct24h: number | null;
  };
  incidents: {
    open: number;
    recent: { id: string; number: string; title: string; severity: string; status: string; detected_at: string }[];
  };
};

const emptyOverview = (): ObservabilityOverview => ({
  configured: false,
  errors24h: { total: 0, bySeverity: {}, byRuntime: {}, openCriticalIssues: 0 },
  logs24h: { total: 0, byLevel: {}, byService: [] },
  traces24h: { spans: 0, byService: [] },
  crons: { jobs: [], totalRuns24h: 0, failures24h: 0 },
  uptime: { targets: [], overallOkPct24h: null },
  incidents: { open: 0, recent: [] },
});

export async function getObservabilityOverview(db: SupabaseClient | null): Promise<ObservabilityOverview> {
  if (!db) return emptyOverview();
  const since24 = new Date(Date.now() - 86_400_000).toISOString();

  const [eventsRes, issuesRes, logsRes, spansRes, cronRes, uptimeRes, incidentsRes] = await Promise.all([
    db.from("error_events").select("severity,runtime,occurred_at").gte("occurred_at", since24).limit(20_000),
    db.from("error_issues").select("id,severity,status").in("status", ["new", "investigating", "assigned", "regressed"]),
    db.from("app_logs").select("level,service,ts").gte("ts", since24).limit(20_000),
    db.from("trace_spans").select("service,duration_ms,status,created_at").gte("created_at", since24).limit(20_000),
    db.from("cron_runs").select("job,ok,ran_at").gte("ran_at", since24).order("ran_at", { ascending: false }).limit(20_000),
    db.from("uptime_checks").select("url,ok,status_code,latency_ms,checked_at").gte("checked_at", since24).order("checked_at", { ascending: false }).limit(20_000),
    db.from("incidents").select("id,number,title,severity,status,detected_at").order("detected_at", { ascending: false }).limit(50),
  ]);

  const out = emptyOverview();
  out.configured = true;

  // ── Errors 24h ──
  const events = (eventsRes.data ?? []) as { severity: string; runtime: string }[];
  for (const e of events) {
    out.errors24h.total += 1;
    out.errors24h.bySeverity[e.severity] = (out.errors24h.bySeverity[e.severity] ?? 0) + 1;
    out.errors24h.byRuntime[e.runtime] = (out.errors24h.byRuntime[e.runtime] ?? 0) + 1;
  }
  const openIssues = (issuesRes.data ?? []) as { severity: string; status: string }[];
  out.errors24h.openCriticalIssues = openIssues.filter((i) => i.severity === "critical").length;

  // ── Logs 24h ──
  const logs = (logsRes.data ?? []) as { level: string; service: string }[];
  const svcCount = new Map<string, number>();
  for (const l of logs) {
    out.logs24h.total += 1;
    out.logs24h.byLevel[l.level] = (out.logs24h.byLevel[l.level] ?? 0) + 1;
    svcCount.set(l.service, (svcCount.get(l.service) ?? 0) + 1);
  }
  out.logs24h.byService = [...svcCount.entries()].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count).slice(0, 15);

  // ── Traces 24h (per-service avg + p95, computed in JS — bounded by limit) ──
  const spans = (spansRes.data ?? []) as { service: string; duration_ms: number; status: string }[];
  const spanSvc = new Map<string, { total: number; count: number; errors: number; durs: number[] }>();
  for (const s of spans) {
    const e = spanSvc.get(s.service) ?? { total: 0, count: 0, errors: 0, durs: [] };
    e.total += Number(s.duration_ms) || 0;
    e.count += 1;
    e.durs.push(Number(s.duration_ms) || 0);
    if (s.status === "error") e.errors += 1;
    spanSvc.set(s.service, e);
  }
  out.traces24h.spans = spans.length;
  out.traces24h.byService = [...spanSvc.entries()].map(([service, e]) => {
    e.durs.sort((a, b) => a - b);
    const p95 = e.durs.length ? e.durs[Math.min(e.durs.length - 1, Math.floor(e.durs.length * 0.95))] : null;
    return { service, avgMs: e.count ? Math.round(e.total / e.count) : null, p95Ms: p95 == null ? null : Math.round(p95), errors: e.errors };
  }).sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0)).slice(0, 15);

  // ── Crons ──
  const crons = (cronRes.data ?? []) as { job: string; ok: boolean; ran_at: string }[];
  // Rows arrive desc-ordered: the first row seen per job is its latest run.
  const byJob = new Map<string, { job: string; lastRunAt: string; lastOk: boolean; runs24h: number; failures24h: number }>();
  for (const c of crons) {
    out.crons.totalRuns24h += 1;
    if (!c.ok) out.crons.failures24h += 1;
    let e = byJob.get(c.job);
    if (!e) {
      e = { job: c.job, lastRunAt: c.ran_at, lastOk: c.ok, runs24h: 0, failures24h: 0 };
      byJob.set(c.job, e);
    }
    e.runs24h += 1;
    if (!c.ok) e.failures24h += 1;
  }
  out.crons.jobs = [...byJob.values()].sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt));

  // ── Uptime ──
  const ups = (uptimeRes.data ?? []) as { url: string; ok: boolean; status_code: number | null; latency_ms: number | null; checked_at: string }[];
  const upByUrl = new Map<string, { url: string; ok: boolean; statusCode: number | null; latencyMs: number | null; checkedAt: string; checks24h: number; okCount: number }>();
  let totalOk = 0;
  for (const u of ups) {
    totalOk += u.ok ? 1 : 0;
    const e = upByUrl.get(u.url) ?? { url: u.url, ok: u.ok, statusCode: u.status_code, latencyMs: u.latency_ms, checkedAt: u.checked_at, checks24h: 0, okCount: 0 };
    if (!upByUrl.has(u.url) || u.checked_at > e.checkedAt) {
      e.ok = u.ok; e.statusCode = u.status_code; e.latencyMs = u.latency_ms; e.checkedAt = u.checked_at;
    }
    e.checks24h += 1;
    if (u.ok) e.okCount += 1;
    upByUrl.set(u.url, e);
  }
  out.uptime.targets = [...upByUrl.values()]
    .map((t) => ({ url: t.url, ok: t.ok, statusCode: t.statusCode, latencyMs: t.latencyMs, checkedAt: t.checkedAt, checks24h: t.checks24h, okPct24h: t.checks24h ? Math.round((t.okCount / t.checks24h) * 1000) / 10 : null }))
    .sort((a, b) => a.url.localeCompare(b.url));
  out.uptime.overallOkPct24h = ups.length ? Math.round((totalOk / ups.length) * 1000) / 10 : null;

  // ── Incidents ──
  const inc = (incidentsRes.data ?? []) as { id: string; number: string; title: string; severity: string; status: string; detected_at: string }[];
  out.incidents.open = inc.filter((i) => i.status !== "resolved").length;
  out.incidents.recent = inc.slice(0, 10);

  return out;
}

/* ─── Detail feeds (read-only) ─────────────────────────────────────────── */

export type ErrorIssueRow = {
  id: string; fingerprint: string; title: string; culprit: string | null;
  status: string; severity: string; event_count: number; first_seen: string; last_seen: string;
};
export async function listErrorIssues(db: SupabaseClient, limit = 100): Promise<ErrorIssueRow[]> {
  const { data } = await db
    .from("error_issues")
    .select("id,fingerprint,title,culprit,status,severity,event_count,first_seen,last_seen")
    .order("last_seen", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));
  return (data ?? []) as ErrorIssueRow[];
}

export type ErrorEventRow = {
  id: number; fingerprint: string; title: string; message: string | null; route: string | null;
  runtime: string; severity: string; occurred_at: string;
};
export async function listErrorEvents(db: SupabaseClient, limit = 100): Promise<ErrorEventRow[]> {
  const { data } = await db
    .from("error_events")
    .select("id,fingerprint,title,message,route,runtime,severity,occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));
  return ((data ?? []) as ErrorEventRow[]).map((e) => ({ ...e, title: scrub(e.title, 200), message: e.message ? scrub(e.message) : null }));
}

export type AppLogRow = {
  id: number; ts: string; level: LogLevel; service: string; message: string; route: string | null; trace_id: string | null;
};
export async function listAppLogs(
  db: SupabaseClient,
  opts: { level?: LogLevel; service?: string; limit?: number } = {},
): Promise<AppLogRow[]> {
  let q = db.from("app_logs").select("id,ts,level,service,message,route,trace_id").order("ts", { ascending: false });
  if (opts.level) q = q.eq("level", opts.level);
  if (opts.service) q = q.eq("service", opts.service);
  const { data } = await q.limit(Math.min(Math.max(opts.limit ?? 100, 1), 300));
  return ((data ?? []) as AppLogRow[]).map((l) => ({ ...l, message: scrub(l.message, 1000) }));
}

export type CronRunRow = { id: number; job: string; ok: boolean; detail: unknown; ran_at: string };
export async function listCronRuns(db: SupabaseClient, opts: { job?: string; limit?: number } = {}): Promise<CronRunRow[]> {
  let q = db.from("cron_runs").select("id,job,ok,detail,ran_at").order("ran_at", { ascending: false });
  if (opts.job) q = q.eq("job", opts.job);
  const { data } = await q.limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  return (data ?? []) as CronRunRow[];
}

export type UptimeRow = { id: number; url: string; ok: boolean; status_code: number | null; latency_ms: number | null; checked_at: string };
export async function listUptimeChecks(db: SupabaseClient, limit = 200): Promise<UptimeRow[]> {
  const { data } = await db.from("uptime_checks").select("id,url,ok,status_code,latency_ms,checked_at").order("checked_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 500));
  return (data ?? []) as UptimeRow[];
}
