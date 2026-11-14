import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppHealthSummary, type AppHealthState } from "./app-health";
import { listIntegrationStatus, type IntegrationRow } from "./integrations";
import { getSystemJobs } from "./jobs";
import { listWebhookSources } from "./webhooks";
import { getFleetStats } from "./fleet-stats";
import { kioskAdapterName } from "./kiosks";
import { assistantConfigured } from "@/lib/ai/openrouter";

/**
 * Unified technical health dashboard (Phase 4.4) for /system/health +
 * GET /api/system/health.
 *
 * Aggregates RECORDED evidence only — no live provider probes on page load:
 *  - app hosts        → getAppHealthSummary (health-profile audits + uptime_checks)
 *  - integrations     → listIntegrationStatus (last audited health checks)
 *  - background jobs  → getSystemJobs (cron_runs + queue tables)
 *  - webhook pipeline → listWebhookSources (stripe/inbound/sms/kiosk ledgers)
 *  - kiosk fleet      → getFleetStats (system_devices + telemetry)
 *  - release campaigns→ kiosk_update_campaigns status counts
 *  - AI services      → ai_agents enabled flags + ai_agent_runs 24h outcomes
 *  - alert delivery   → ALERT_WEBHOOK_URL presence + latest app_logs alert row
 *
 * Every section degrades independently: a failed sub-query marks THAT section
 * 'unverified' (or 'unconfigured' when the backend is absent) — it never
 * fabricates health and never sinks the whole dashboard. State vocabulary:
 *   healthy | degraded | unreachable | unconfigured | unverified | awaiting_hardware
 * 'unverified' = no recorded evidence; 'awaiting_hardware' = the kiosk control
 * path is honestly blocked on a certified vendor adapter (docs/GATEWAY-ADAPTER.md).
 */

export type HealthState =
  | "healthy"
  | "degraded"
  | "unreachable"
  | "unconfigured"
  | "unverified"
  | "awaiting_hardware";

export type HealthSection = {
  id: string;
  title: string;
  state: HealthState;
  /** Headline counts, e.g. "5/7 hosts healthy". */
  summary: string;
  /** Top issue / evidence note — null when clean. */
  issue: string | null;
  /** Console path where the detail lives. */
  href: string;
  hrefLabel: string;
  /** Newest evidence timestamp used, ISO — null when none. */
  checkedAt: string | null;
};

export type SystemHealthDashboard = {
  generatedAt: string;
  overall: HealthState;
  sections: HealthSection[];
};

/* ── State helpers ──────────────────────────────────────────────────────── */

/** Higher = worse. Used for section + overall rollup. */
const RANK: Record<HealthState, number> = {
  healthy: 0,
  unverified: 1,
  unconfigured: 2,
  awaiting_hardware: 3,
  degraded: 4,
  unreachable: 5,
};

export function worstState(states: HealthState[]): HealthState {
  return states.reduce<HealthState>((w, s) => (RANK[s] > RANK[w] ? s : w), "healthy");
}

const newest = (isos: (string | null)[]): string | null =>
  isos.filter((x): x is string => Boolean(x)).sort().pop() ?? null;

const DAY_MS = 24 * 3600_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = any;
async function headCount(db: SupabaseClient, table: string, apply?: (q: Q) => Q): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true });
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── Section builders (each independently fault-tolerant) ───────────────── */

async function appHostsSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "app_hosts", title: "Application hosts", href: "/system/app", hrefLabel: "app infrastructure" };
  try {
    const s = await getAppHealthSummary(db);
    const counts = { healthy: 0, degraded: 0, unreachable: 0, unverified: 0, not_configured: 0 };
    for (const a of s.apps) counts[a.state] += 1;
    // Map AppHealthState → dashboard vocabulary (not_configured → unconfigured).
    const states: HealthState[] = s.apps.map((a): HealthState =>
      a.state === "not_configured" ? "unconfigured" : a.state,
    );
    const state = worstState(states);
    const bad = s.apps.find((a) => a.state !== "healthy");
    return {
      ...base,
      state,
      summary: `${counts.healthy}/${s.apps.length} hosts healthy` +
        (counts.degraded || counts.unreachable ? ` · ${counts.degraded} degraded · ${counts.unreachable} unreachable` : "") +
        (counts.unverified ? ` · ${counts.unverified} unverified` : ""),
      issue: bad ? `${bad.label} (${bad.host}): ${bad.state}${bad.note ? ` — ${bad.note}` : ""}` : null,
      checkedAt: newest(s.apps.map((a) => a.checkedAt)),
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "health evidence unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

/** Buckets one registry row into the dashboard vocabulary. */
function integrationBucket(r: IntegrationRow): HealthState {
  const hc = r.lastHealthCheck;
  if (!r.configured) return "unconfigured";
  switch (hc?.status) {
    case "operational": return "healthy";
    case "degraded": return "degraded";
    case "unconfigured": return "unconfigured";
    default: return "unverified"; // unknown / requires_credentials / not_verified / never checked
  }
}

async function integrationsSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "integrations", title: "Integrations", href: "/system/integrations", hrefLabel: "integration registry" };
  try {
    const rows = await listIntegrationStatus(db);
    const buckets = rows.map(integrationBucket);
    const state = worstState(buckets);
    const n = (s: HealthState) => buckets.filter((b) => b === s).length;
    const degraded = rows.filter((_, i) => buckets[i] === "degraded").map((r) => r.name);
    const unconfigured = rows.filter((_, i) => buckets[i] === "unconfigured").length;
    const issueParts: string[] = [];
    if (degraded.length) issueParts.push(`degraded: ${degraded.join(", ")}`);
    if (unconfigured) issueParts.push(`${unconfigured} unconfigured`);
    if (!issueParts.length && n("unverified")) issueParts.push(`${n("unverified")} configured but unverified (no 'operational' check on record)`);
    return {
      ...base,
      state,
      summary: `${n("healthy")}/${rows.length} verified · ${n("unverified")} unverified · ${n("unconfigured")} unconfigured · ${n("degraded")} degraded`,
      issue: issueParts.length ? issueParts.join(" · ") : null,
      checkedAt: newest(rows.map((r) => r.lastHealthCheck?.checkedAt ?? null)),
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "registry unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

async function jobsSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "jobs", title: "Background jobs", href: "/system/jobs", hrefLabel: "jobs & workers" };
  if (!db) return { ...base, state: "unconfigured", summary: "backend not configured", issue: null, checkedAt: null };
  try {
    const j = await getSystemJobs(db);
    // Paused jobs (jobs.paused app setting) record skipped runs — they are an
    // operator decision, not a failure, so they never degrade this section.
    const failedCron = j.cron.filter((c) => !c.paused && (c.failures24h > 0 || c.lastOk === false));
    const failedDistinct = [...new Set(failedCron.map((c) => c.job))];
    const pausedCount = j.cron.filter((c) => c.paused).length;
    const queueFailures = j.queues.reduce((n, q) => n + (q.failures24h ?? 0), 0);
    const pending = j.queues.reduce((n, q) => n + (q.pending ?? 0), 0);
    const neverRan = j.cron.length > 0 && j.cron.every((c) => c.lastRunAt === null);
    const state: HealthState =
      failedDistinct.length > 0 || queueFailures > 0 ? "degraded"
      : neverRan ? "unverified"
      : "healthy";
    const issueParts: string[] = [];
    if (failedDistinct.length) issueParts.push(`failing cron: ${failedDistinct.join(", ")}`);
    if (queueFailures > 0) issueParts.push(`${queueFailures} dead/failed queue item(s)`);
    if (neverRan) issueParts.push("no cron_runs recorded — scheduler may not be firing");
    if (pausedCount > 0) issueParts.push(`${pausedCount} cron job(s) paused via jobs.paused`);
    return {
      ...base,
      state,
      summary: `${j.cron.length} cron jobs${pausedCount ? ` (${pausedCount} paused)` : ""} · ${pending} queued · ${queueFailures} failed (24h)`,
      issue: issueParts.length ? issueParts.join(" · ") : null,
      checkedAt: newest(j.cron.map((c) => c.lastRunAt)),
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "jobs report unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

async function webhooksSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "webhooks", title: "Webhook pipeline", href: "/system/webhooks", hrefLabel: "webhook inspector" };
  if (!db) return { ...base, state: "unconfigured", summary: "backend not configured", issue: null, checkedAt: null };
  try {
    const sources = await listWebhookSources(db);
    if (sources.length === 0) {
      return { ...base, state: "unverified", summary: "no webhook sources", issue: "source tables returned no rows — pipeline state unknown", checkedAt: null };
    }
    const failures = sources.reduce((n, s) => n + (s.failures24h ?? 0), 0);
    const pending = sources.reduce((n, s) => n + (s.pending ?? 0), 0);
    const anyEvent = sources.some((s) => s.lastEventAt !== null);
    const state: HealthState = failures > 0 ? "degraded" : anyEvent ? "healthy" : "unverified";
    const failing = sources.filter((s) => (s.failures24h ?? 0) > 0).map((s) => s.provider);
    return {
      ...base,
      state,
      summary: `${sources.length} sources · ${failures} failures (24h) · ${pending} pending`,
      issue: failing.length
        ? `failures on: ${failing.join(", ")}`
        : anyEvent ? null : "no webhook events recorded on any source",
      checkedAt: newest(sources.map((s) => s.lastEventAt)),
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "webhook sources unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

async function kioskFleetSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "kiosk_fleet", title: "Kiosk fleet", href: "/system/kiosks", hrefLabel: "fleet registry" };
  if (!db) return { ...base, state: "unconfigured", summary: "backend not configured", issue: null, checkedAt: null };
  try {
    const fs = await getFleetStats(db);
    if ("error" in fs) {
      return { ...base, state: "unreachable", summary: "fleet stats unavailable", issue: fs.error.slice(0, 160), checkedAt: null };
    }
    const adapter = kioskAdapterName();
    const online = fs.connectivity.online;
    const stale = fs.connectivity.stale;
    const noData = fs.connectivity.no_data;
    const faulted = fs.faulted ?? 0;
    const authFail = fs.auth_failures ?? 0;
    const issues = fs.errors.length ? `partial: ${fs.errors[0]}` : null;

    let state: HealthState;
    if (fs.total === 0) state = "unverified";
    else if (faulted > 0 || authFail > 0) state = "degraded";
    else if (adapter === "none") state = "awaiting_hardware";
    else state = "healthy";

    const issueParts: string[] = [];
    if (faulted > 0) issueParts.push(`${faulted} faulted`);
    if (authFail > 0) issueParts.push(`${authFail} auth failures (24h)`);
    if (fs.total === 0) issueParts.push("no devices registered");
    if (adapter === "none" && state !== "degraded") issueParts.push("KIOSK_ADAPTER=none — outbound control awaits a certified vendor adapter (docs/GATEWAY-ADAPTER.md)");
    if (issues) issueParts.push(issues);

    return {
      ...base,
      state,
      summary: `${fs.total} devices · ${online} online · ${stale} stale · ${noData} no-data · adapter=${adapter}`,
      issue: issueParts.length ? issueParts.join(" · ") : null,
      checkedAt: fs.computed_at,
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "fleet stats unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

const CAMPAIGN_BUCKETS = ["active", "paused", "scheduled", "pending_approval", "blocked", "failed"] as const;

async function campaignsSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "update_campaigns", title: "Release campaigns", href: "/system/kiosks/updates", hrefLabel: "kiosk updates" };
  if (!db) return { ...base, state: "unconfigured", summary: "backend not configured", issue: null, checkedAt: null };
  try {
    // Bounded single-column scan, grouped in JS (statuses are a small enum).
    const { data, error } = await db
      .from("kiosk_update_campaigns")
      .select("status")
      .limit(2000);
    if (error) {
      const missing = /42P01|PGRST205|does not exist|schema cache/i.test(`${error.code ?? ""} ${error.message ?? ""}`);
      return {
        ...base,
        state: missing ? "unconfigured" : "unverified",
        summary: "campaigns not queryable",
        issue: (error.message ?? "query failed").slice(0, 160),
        checkedAt: null,
      };
    }
    const counts: Record<string, number> = {};
    for (const r of (data ?? []) as { status?: string }[]) {
      if (r.status) counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const blocked = counts.blocked ?? 0;
    const failed = counts.failed ?? 0;
    const state: HealthState = blocked > 0 || failed > 0 ? "degraded" : "healthy";
    const parts = CAMPAIGN_BUCKETS.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
    return {
      ...base,
      state,
      summary: total === 0 ? "no campaigns" : `${total} campaigns · ${parts.join(" · ")}`,
      issue: blocked + failed > 0 ? `${blocked} blocked · ${failed} failed — review on /system/kiosks/updates` : null,
      checkedAt: null,
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "campaigns unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

async function aiServicesSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "ai_services", title: "AI services", href: "/system/ai", hrefLabel: "AI console" };
  if (!db) return { ...base, state: "unconfigured", summary: "backend not configured", issue: null, checkedAt: null };
  try {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const [enabled, disabled, errors24, ok24] = await Promise.all([
      headCount(db, "ai_agents", (q) => q.eq("enabled", true)),
      headCount(db, "ai_agents", (q) => q.eq("enabled", false)),
      headCount(db, "ai_agent_runs", (q) => q.eq("status", "error").gte("created_at", since)),
      headCount(db, "ai_agent_runs", (q) => q.eq("status", "ok").gte("created_at", since)),
    ]);
    if (enabled === null && disabled === null) {
      return { ...base, state: "unverified", summary: "agent registry not queryable", issue: "ai_agents unavailable — check migration 0029", checkedAt: null };
    }
    const en = enabled ?? 0;
    const dis = disabled ?? 0;
    const total = en + dis;
    const providerMissing = en > 0 && !assistantConfigured();
    const state: HealthState =
      providerMissing ? "degraded"
      : (errors24 ?? 0) > 0 ? "degraded"
      : total === 0 ? "unverified"
      : "healthy";
    const issueParts: string[] = [];
    if (providerMissing) issueParts.push("OPENROUTER_API_KEY missing — enabled agents cannot complete runs");
    if ((errors24 ?? 0) > 0) issueParts.push(`${errors24} failed agent run(s) (24h)`);
    if (total === 0) issueParts.push("no agents registered");
    return {
      ...base,
      state,
      summary: `${en} enabled · ${dis} disabled · ${ok24 ?? "?"} ok / ${errors24 ?? "?"} error runs (24h)`,
      issue: issueParts.length ? issueParts.join(" · ") : null,
      checkedAt: null,
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "AI services unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

async function alertsSection(db: SupabaseClient | null): Promise<HealthSection> {
  const base = { id: "alert_delivery", title: "Alert delivery", href: "/system/observability/alerts", hrefLabel: "alert channels" };
  const configured = Boolean(process.env.ALERT_WEBHOOK_URL);
  if (!configured) {
    return { ...base, state: "unconfigured", summary: "ALERT_WEBHOOK_URL not set", issue: "external push alerting disabled — in-app incidents + staff email still run", checkedAt: null };
  }
  if (!db) {
    return { ...base, state: "unverified", summary: "ALERT_WEBHOOK_URL set · backend unavailable", issue: "cannot read app_logs for delivery evidence", checkedAt: null };
  }
  try {
    const { data, error } = await db
      .from("app_logs")
      .select("ts,message")
      .in("message", ["external_alert_delivered", "external_alert_failed"])
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { ...base, state: "unverified", summary: "ALERT_WEBHOOK_URL set · app_logs not queryable", issue: "delivery evidence unavailable", checkedAt: null };
    }
    const row = data as { ts?: string; message?: string } | null;
    if (!row?.message) {
      return { ...base, state: "unverified", summary: "ALERT_WEBHOOK_URL set · never fired", issue: "no alert has ever been emitted — endpoint delivery unverified (alerts fire only on new warning/critical issues)", checkedAt: null };
    }
    const delivered = row.message === "external_alert_delivered";
    return {
      ...base,
      state: delivered ? "healthy" : "degraded",
      summary: `ALERT_WEBHOOK_URL set · last ${delivered ? "delivered" : "FAILED"}`,
      issue: delivered ? null : "latest external alert failed — check webhook reachability",
      checkedAt: row.ts ?? null,
    };
  } catch (e) {
    return { ...base, state: "unverified", summary: "ALERT_WEBHOOK_URL set · evidence unavailable", issue: e instanceof Error ? e.message.slice(0, 160) : "probe failed", checkedAt: null };
  }
}

/* ── Aggregation ────────────────────────────────────────────────────────── */

/**
 * Builds the full dashboard. Never throws — every section is independently
 * guarded. db=null (unconfigured Supabase) still returns env-level sections
 * (alert delivery, integration presence) with honest unconfigured/unverified.
 */
export async function getSystemHealth(db: SupabaseClient | null): Promise<SystemHealthDashboard> {
  const sections = await Promise.all([
    appHostsSection(db),
    integrationsSection(db),
    jobsSection(db),
    webhooksSection(db),
    kioskFleetSection(db),
    campaignsSection(db),
    aiServicesSection(db),
    alertsSection(db),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    overall: worstState(sections.map((s) => s.state)),
    sections,
  };
}
