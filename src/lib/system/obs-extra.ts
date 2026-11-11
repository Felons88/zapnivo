import type { SupabaseClient } from "@supabase/supabase-js";
import { listUptimeChecks } from "./observability";

/**
 * Extended observability read models for system.zapnivo.com sub-pages
 * (/system/observability/traces, /system/observability/alerts).
 *
 * Read-only, bounded queries. No PII: trace_spans.attrs is never selected;
 * incidents carry operational metadata only.
 */

/* ─── Trace explorer ────────────────────────────────────────────────────── */

export type TraceSpanRow = {
  id: number;
  trace_id: string;
  parent_span_id: string | null;
  span_id: string;
  name: string;
  service: string;
  kind: string;
  duration_ms: number;
  status: string;
  created_at: string;
};

export type TraceGroup = {
  trace_id: string;
  spanCount: number;
  services: string[];
  /** Sum of span durations in the window (spans may overlap — this is work time, not wall time). */
  totalDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
  firstAt: string;
  lastAt: string;
  spans: TraceSpanRow[];
};

/** Recent spans, newest first. Bounded: ≤ `limit` rows within trailing `hours`. */
export async function listTraceSpans(
  db: SupabaseClient,
  opts: { hours?: number; limit?: number } = {},
): Promise<TraceSpanRow[]> {
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 168);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data } = await db
    .from("trace_spans")
    .select("id,trace_id,parent_span_id,span_id,name,service,kind,duration_ms,status,created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    trace_id: String(r.trace_id ?? ""),
    parent_span_id: (r.parent_span_id as string | null) ?? null,
    span_id: String(r.span_id ?? ""),
    name: String(r.name ?? ""),
    service: String(r.service ?? ""),
    kind: String(r.kind ?? ""),
    duration_ms: Number(r.duration_ms) || 0,
    status: String(r.status ?? ""),
    created_at: String(r.created_at ?? ""),
  }));
}

/** Groups flat span rows by trace_id. Input order preserved per group; groups sorted by lastAt desc. */
export function groupTraces(spans: TraceSpanRow[], maxGroups = 50): TraceGroup[] {
  const byTrace = new Map<string, TraceSpanRow[]>();
  for (const s of spans) {
    const list = byTrace.get(s.trace_id) ?? [];
    list.push(s);
    byTrace.set(s.trace_id, list);
  }
  const groups: TraceGroup[] = [];
  for (const [trace_id, list] of byTrace) {
    const services = [...new Set(list.map((s) => s.service))].sort();
    groups.push({
      trace_id,
      spanCount: list.length,
      services,
      totalDurationMs: Math.round(list.reduce((a, s) => a + s.duration_ms, 0)),
      maxDurationMs: Math.round(Math.max(...list.map((s) => s.duration_ms))),
      errorCount: list.filter((s) => s.status === "error").length,
      firstAt: list.reduce((a, s) => (s.created_at < a ? s.created_at : a), list[0].created_at),
      lastAt: list.reduce((a, s) => (s.created_at > a ? s.created_at : a), list[0].created_at),
      spans: list.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
    });
  }
  return groups.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, maxGroups);
}

/* ─── Alerts & incidents ────────────────────────────────────────────────── */

export type IncidentRow = {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
  source: string | null;
  services: string[];
  summary: string | null;
  detected_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

export async function listIncidents(db: SupabaseClient, limit = 50): Promise<IncidentRow[]> {
  const { data } = await db
    .from("incidents")
    .select("id,number,title,severity,status,source,services,summary,detected_at,acknowledged_at,resolved_at,created_at")
    .order("detected_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    number: String(r.number ?? ""),
    title: String(r.title ?? ""),
    severity: String(r.severity ?? ""),
    status: String(r.status ?? ""),
    source: (r.source as string | null) ?? null,
    services: Array.isArray(r.services) ? (r.services as unknown[]).filter((s): s is string => typeof s === "string") : [],
    summary: (r.summary as string | null) ?? null,
    detected_at: String(r.detected_at ?? ""),
    acknowledged_at: (r.acknowledged_at as string | null) ?? null,
    resolved_at: (r.resolved_at as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  }));
}

export type CronFailure = { job: string; ran_at: string };

export type AlertsOverview = {
  configured: boolean;
  incidents: {
    open: number;
    recent: IncidentRow[];
  };
  uptime: {
    targets: { url: string; ok: boolean; statusCode: number | null; latencyMs: number | null; checkedAt: string; checks24h: number; okPct24h: number | null }[];
    overallOkPct24h: number | null;
  };
  cron: {
    runs24h: number;
    failures24h: number;
    failures: CronFailure[];
  };
  /** Static alerting policy text — rendered on the page, also returned by the API. */
  policy: {
    externalMonitor: string;
    workflowPath: string;
    workflowUrl: string;
    notes: readonly string[];
  };
};

const OPEN_INCIDENT_STATUSES = new Set(["detected", "investigating", "identified", "mitigating", "monitoring"]);

export const ALERT_POLICY = {
  externalMonitor: "GitHub Actions workflow .github/workflows/uptime.yml — runs OUTSIDE Vercel every ~15 min, probes all public properties, opens/updates a deduplicated GitHub issue on failure and comments/closes on recovery.",
  workflowPath: ".github/workflows/uptime.yml",
  workflowUrl: "https://github.com/Felons88/zapnivo/blob/main/.github/workflows/uptime.yml",
  notes: [
    "In-app signals (uptime_checks, cron_runs, error_events) are recorded here but do not page anyone — alerting is the external workflow + issue tracker.",
    "Incidents rows are operational records; severity sev1–sev4 maps to business impact, not paging urgency.",
    "This console is read-only — incident lifecycle changes happen in the incident workflow, not here.",
  ],
} as const;

export async function getAlertsOverview(db: SupabaseClient | null): Promise<AlertsOverview> {
  const empty: AlertsOverview = {
    configured: Boolean(db),
    incidents: { open: 0, recent: [] },
    uptime: { targets: [], overallOkPct24h: null },
    cron: { runs24h: 0, failures24h: 0, failures: [] },
    policy: ALERT_POLICY,
  };
  if (!db) return empty;

  const since24 = new Date(Date.now() - 86_400_000).toISOString();
  const [incidents, uptimeRows, cronRes] = await Promise.all([
    listIncidents(db, 50),
    listUptimeChecks(db, 1000),
    db.from("cron_runs").select("job,ok,ran_at").gte("ran_at", since24).order("ran_at", { ascending: false }).limit(20_000),
  ]);

  // Latest check per URL + 24h ok-rate (same aggregation as the overview page).
  const upByUrl = new Map<string, { url: string; ok: boolean; statusCode: number | null; latencyMs: number | null; checkedAt: string; checks24h: number; okCount: number }>();
  let totalOk = 0;
  let totalChecks = 0;
  for (const u of uptimeRows) {
    if (u.checked_at < since24) continue;
    totalChecks += 1;
    if (u.ok) totalOk += 1;
    const e = upByUrl.get(u.url) ?? { url: u.url, ok: u.ok, statusCode: u.status_code, latencyMs: u.latency_ms, checkedAt: u.checked_at, checks24h: 0, okCount: 0 };
    if (!upByUrl.has(u.url) || u.checked_at > e.checkedAt) {
      e.ok = u.ok; e.statusCode = u.status_code; e.latencyMs = u.latency_ms; e.checkedAt = u.checked_at;
    }
    e.checks24h += 1;
    if (u.ok) e.okCount += 1;
    upByUrl.set(u.url, e);
  }
  const targets = [...upByUrl.values()]
    .map((t) => ({ url: t.url, ok: t.ok, statusCode: t.statusCode, latencyMs: t.latencyMs, checkedAt: t.checkedAt, checks24h: t.checks24h, okPct24h: t.checks24h ? Math.round((t.okCount / t.checks24h) * 1000) / 10 : null }))
    .sort((a, b) => a.url.localeCompare(b.url));

  type RawCron = { job: string; ok: boolean; ran_at: string };
  const cronRows = (cronRes.data ?? []) as unknown as RawCron[];
  const failures = cronRows.filter((c) => !c.ok).slice(0, 100).map((c) => ({ job: c.job, ran_at: c.ran_at }));

  return {
    configured: true,
    incidents: {
      open: incidents.filter((i) => OPEN_INCIDENT_STATUSES.has(i.status)).length,
      recent: incidents.slice(0, 25),
    },
    uptime: {
      targets,
      overallOkPct24h: totalChecks ? Math.round((totalOk / totalChecks) * 1000) / 10 : null,
    },
    cron: {
      runs24h: cronRows.length,
      failures24h: failures.length,
      failures,
    },
    policy: ALERT_POLICY,
  };
}
