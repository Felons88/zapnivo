import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PROFILES, healthProfileApps } from "./deploy-health";

/**
 * Unified per-app health summary (Phase 4.1) for /system/app +
 * GET /api/system/app/health.
 *
 * Sources, in order of trust:
 *  1. system_audit_events rows with action 'deployment.health_profile' —
 *     written by runAndRecordHealthProfile on every profile run. The detail
 *     payload carries the profile's critical-check-weighted verdict
 *     (health_status, checks_ok/total, critical_failures), so a single HTTP
 *     200 is never treated as sufficient.
 *  2. uptime_checks rows (written by recordHealthProfile, one row per check)
 *     grouped by profile host — fallback when no profile audit exists yet.
 *     These rows carry NO criticality flag, so the derived state is reported
 *     with source:'uptime_checks' and criticalFailures:null (unknown, not 0).
 *
 * No live probes are made here — this module only reads recorded evidence.
 * 'unverified' means no recorded evidence exists; 'not_configured' is
 * reserved for profiles that cannot resolve a host (none today).
 */

export type AppHealthState = "healthy" | "degraded" | "unreachable" | "not_configured" | "unverified";

export type AppHealthEntry = {
  app: string;
  label: string;
  host: string;
  state: AppHealthState;
  /** Timestamp of the newest evidence used, ISO — null when unverified. */
  checkedAt: string | null;
  /** Critical-check failure count from a health profile; null when the
   *  source cannot weight checks (uptime_checks) or there is no evidence. */
  criticalFailures: number | null;
  checksOk: number | null;
  checksTotal: number | null;
  source: "health_profile" | "uptime_checks" | "none";
  /** Console path where the profile can be run/inspected. */
  detailPath: string;
  note: string | null;
};

export type AppHealthSummary = {
  configured: boolean;
  generatedAt: string;
  apps: AppHealthEntry[];
};

const PROFILE_ACTION = "deployment.health_profile";
const AUDIT_LIMIT = 1000;
const UPTIME_LIMIT = 5000;
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

type AuditEventRow = {
  resource: string;
  created_at: string;
  detail: Record<string, unknown> | null;
};

type UptimeRow = {
  url: string;
  ok: boolean;
  status_code: number | null;
  checked_at: string;
};

const PROFILE_STATES = new Set(["healthy", "degraded", "unreachable"]);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Latest deployment.health_profile audit event per app resource. */
async function latestProfileAudits(db: SupabaseClient): Promise<Map<string, AuditEventRow>> {
  const latest = new Map<string, AuditEventRow>();
  try {
    const { data, error } = await db
      .from("system_audit_events")
      .select("resource,created_at,detail")
      .eq("action", PROFILE_ACTION)
      .order("created_at", { ascending: false })
      .limit(AUDIT_LIMIT);
    if (error) return latest;
    for (const row of (data ?? []) as AuditEventRow[]) {
      // resource is "health_profile:{app}" — first (newest) row per app wins.
      if (!latest.has(row.resource)) latest.set(row.resource, row);
    }
  } catch {
    /* audit read is best-effort */
  }
  return latest;
}

/** Recent uptime_checks rows grouped by hostname (bounded window). */
async function recentUptimeByHost(db: SupabaseClient): Promise<Map<string, UptimeRow[]>> {
  const byHost = new Map<string, UptimeRow[]>();
  try {
    const since = new Date(Date.now() - UPTIME_WINDOW_MS).toISOString();
    const { data, error } = await db
      .from("uptime_checks")
      .select("url,ok,status_code,checked_at")
      .gte("checked_at", since)
      .order("checked_at", { ascending: false })
      .limit(UPTIME_LIMIT);
    if (error) return byHost;
    for (const row of (data ?? []) as UptimeRow[]) {
      let host = "";
      try { host = new URL(row.url).hostname.toLowerCase(); } catch { continue; }
      const list = byHost.get(host) ?? [];
      if (list.length < 200) list.push(row); // cap per host
      byHost.set(host, list);
    }
  } catch {
    /* uptime read is best-effort */
  }
  return byHost;
}

/** Derives a state from raw uptime_checks rows — no critical weighting exists. */
function stateFromUptime(rows: UptimeRow[]): { state: AppHealthState; checkedAt: string | null; failed: number } {
  const checkedAt = rows[0]?.checked_at ?? null;
  const failed = rows.filter((r) => !r.ok).length;
  if (rows.length === 0) return { state: "unverified", checkedAt: null, failed: 0 };
  const responded = rows.filter((r) => r.status_code !== null);
  if (responded.length === 0) {
    // Every recorded probe failed to get any HTTP response.
    return { state: "unreachable", checkedAt, failed };
  }
  if (failed === 0) return { state: "healthy", checkedAt, failed: 0 };
  return { state: "degraded", checkedAt, failed };
}

/**
 * Aggregates recorded health evidence for all APP_PROFILES hosts.
 * Never probes the network — 'unverified' is returned honestly when no
 * evidence exists. db=null (unconfigured Supabase) → all apps 'unverified'.
 */
export async function getAppHealthSummary(db: SupabaseClient | null): Promise<AppHealthSummary> {
  const apps = healthProfileApps();
  const generatedAt = new Date().toISOString();
  if (!db) {
    return {
      configured: false,
      generatedAt,
      apps: apps.map((a) => ({
        app: a.app, label: a.label, host: a.host,
        state: "unverified" as const, checkedAt: null, criticalFailures: null,
        checksOk: null, checksTotal: null, source: "none" as const,
        detailPath: "/system/deployments",
        note: "service client unavailable — no recorded health evidence",
      })),
    };
  }

  const [audits, uptime] = await Promise.all([latestProfileAudits(db), recentUptimeByHost(db)]);

  const entries: AppHealthEntry[] = APP_PROFILES.map((profile) => {
    const meta = apps.find((a) => a.app === profile.app);
    const resolvedHost = meta?.host ?? "";
    const base = {
      app: profile.app,
      label: profile.label,
      host: resolvedHost,
      detailPath: "/system/deployments",
    };
    if (!resolvedHost) {
      return { ...base, state: "not_configured" as const, checkedAt: null, criticalFailures: null, checksOk: null, checksTotal: null, source: "none" as const, note: "host could not be resolved" };
    }

    // 1) Authoritative: latest health-profile audit event for this app.
    const audit = audits.get(`health_profile:${profile.app}`);
    if (audit) {
      const detail = asRecord(audit.detail);
      const status = str(detail.health_status);
      const critical = Array.isArray(detail.critical_failures) ? detail.critical_failures.length : null;
      const checksOk = typeof detail.checks_ok === "number" ? detail.checks_ok : null;
      const checksTotal = typeof detail.checks_total === "number" ? detail.checks_total : null;
      const state: AppHealthState = status && PROFILE_STATES.has(status) ? (status as AppHealthState) : "unverified";
      return {
        ...base,
        state,
        checkedAt: audit.created_at ?? null,
        criticalFailures: critical,
        checksOk,
        checksTotal,
        source: "health_profile" as const,
        note: state === "unverified" ? "audit detail missing health_status" : null,
      };
    }

    // 2) Fallback: recent uptime_checks rows for this host.
    const rows = uptime.get(resolvedHost.toLowerCase()) ?? [];
    if (rows.length > 0) {
      const u = stateFromUptime(rows);
      return {
        ...base,
        state: u.state,
        checkedAt: u.checkedAt,
        criticalFailures: null, // uptime_checks rows carry no criticality — unknown, not zero
        checksOk: null,
        checksTotal: null,
        source: "uptime_checks" as const,
        note: u.state === "degraded"
          ? `${u.failed} failed probe(s) in 24h — criticality unknown (no health profile run recorded)`
          : "derived from raw uptime_checks — run a health profile for critical-weighted verdict",
      };
    }

    return {
      ...base,
      state: "unverified" as const,
      checkedAt: null,
      criticalFailures: null,
      checksOk: null,
      checksTotal: null,
      source: "none" as const,
      note: "no health profile run or uptime probes recorded for this host",
    };
  });

  return { configured: true, generatedAt, apps: entries };
}
