import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MIGRATIONS, MANIFEST_TABLES, MANIFEST_NOTE, githubBlobUrl } from "./database";
import { CRON_ROUTES } from "./jobs";
import { sanitizeAuditDetail } from "./audit";
import { securityReadiness, type BackupState, type ProviderBackupSnapshot } from "./readiness";

/**
 * Infrastructure database admin read-model for
 * /system/infrastructure/database (+ GET /api/system/infrastructure/database).
 *
 * Honest-by-construction rules:
 *  - NO arbitrary SQL. The only queries are bounded head counts and small
 *    ordered selects through the Supabase client. There is deliberately no
 *    query console.
 *  - Postgres internals that PostgREST does not expose (pg_database_size,
 *    pg_stat_statements, live index usage) are reported as unavailable with a
 *    pointer to the Supabase dashboard — never estimated or fabricated.
 *  - Migration "applied" state is NOT tracked per-file by PostgREST; the repo
 *    manifest (migrations-manifest.json) is shown as repo truth only.
 *  - RLS coverage is derived by scanning supabase/migrations/*.sql for
 *    `alter table … enable row level security` — repo truth, not a live probe.
 */

export type DbStat = {
  table: string;
  label: string;
  /** Exact head count, or null when the query failed (error carries the code). */
  rows: number | null;
  error?: string;
};

/** Key operational tables probed with bounded head counts (parallel, allSettled). */
export const DB_ADMIN_TABLES: readonly { table: string; label: string }[] = [
  { table: "rentals", label: "Rentals" },
  { table: "payments", label: "Payments" },
  { table: "billing_ledger", label: "Billing ledger" },
  { table: "system_devices", label: "System devices (control plane)" },
  { table: "device_events", label: "Device event log" },
  { table: "system_device_messages", label: "Device auth telemetry" },
  { table: "email_outbox", label: "Email outbox" },
  { table: "inbound_jobs", label: "Inbound email jobs" },
  { table: "inbound_emails", label: "Inbound email log" },
  { table: "sms_messages", label: "SMS messages" },
  { table: "stripe_events", label: "Stripe webhook events" },
  { table: "system_audit_events", label: "System audit events" },
  { table: "error_events", label: "Error events" },
  { table: "app_logs", label: "Application logs" },
  { table: "trace_spans", label: "Trace spans" },
  { table: "ai_agent_runs", label: "AI agent runs" },
  { table: "cron_runs", label: "Cron run history" },
  { table: "system_change_requests", label: "Change requests" },
  { table: "system_feature_flags", label: "Feature flags" },
  { table: "support_tickets", label: "Support tickets" },
];

export type UnavailableProbe = { status: "unavailable"; note: string };

export type MigrationInfo = {
  repoMigrationCount: number;
  repoTableCount: number;
  /** Highest-numbered migration file present in the repo (e.g. "0057_email_delivery_tracking.sql"). */
  repoLatestFile: string | null;
  repoLatestNumber: number | null;
  /** Per-file remote applied state is NOT exposed via PostgREST. */
  remoteAppliedState: "untracked";
  note: string;
  files: { file: string; number: number | null; title: string; blobUrl: string }[];
};

export type RlsCoverage =
  | {
      status: "scanned";
      manifestTables: number;
      rlsEnabledTables: number;
      /** Manifest tables with no `enable row level security` found in migrations. */
      uncoveredTables: string[];
      note: string;
    }
  | { status: "unavailable"; note: string };

export type IndexSummary =
  | { status: "scanned"; createIndexStatements: number; tablesWithRls: number; note: string }
  | { status: "unavailable"; note: string };

export type DatabaseAdminReport = {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
  detail: string;
  stats: DbStat[];
  /** Postgres catalog internals are not reachable via PostgREST. */
  databaseSize: UnavailableProbe;
  slowQueries: UnavailableProbe;
  indexHealth: IndexSummary;
  migrations: MigrationInfo;
  rls: RlsCoverage;
  backup: {
    state: BackupState | null;
    providerSnapshot: ProviderBackupSnapshot | null;
    recoveryLastTest: { result: string | null; tested_at: string | null; environment: string | null } | null;
    retentionLastRun: { status: string | null; mode: string | null; created_at: string | null } | null;
    note: string;
  } | null;
};

/* ── Repo scans (migrations dir) ────────────────────────────────────────── */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

function readMigrationSources(): { file: string; sql: string }[] | null {
  try {
    return readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), "utf8") }));
  } catch {
    return null;
  }
}

/** Tables with `alter table <t> enable row level security` anywhere in migrations. */
export function scanRlsTables(): Set<string> | null {
  const files = readMigrationSources();
  if (!files) return null;
  const tables = new Set<string>();
  const re = /alter\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gi;
  for (const { sql } of files) {
    for (const m of sql.matchAll(re)) tables.add(m[1].toLowerCase());
  }
  return tables;
}

/** Count of `create [unique] index` statements across migrations (repo truth). */
export function scanIndexCount(): number | null {
  const files = readMigrationSources();
  if (!files) return null;
  let n = 0;
  for (const { sql } of files) {
    n += (sql.match(/create\s+(?:unique\s+)?index\s/gi) ?? []).length;
  }
  return n;
}

function buildMigrationInfo(): MigrationInfo {
  const sorted = [...MIGRATIONS].sort((a, b) => (b.number ?? -1) - (a.number ?? -1));
  const latest = sorted[0] ?? null;
  return {
    repoMigrationCount: MIGRATIONS.length,
    repoTableCount: MANIFEST_TABLES.length,
    repoLatestFile: latest?.file ?? null,
    repoLatestNumber: latest?.number ?? null,
    remoteAppliedState: "untracked",
    note: MANIFEST_NOTE + " Per-file remote applied state is not exposed via PostgREST — verify with `supabase migration list` or Dashboard → Database → Migrations.",
    files: [...MIGRATIONS]
      .sort((a, b) => (b.number ?? -1) - (a.number ?? -1))
      .map((m) => ({ file: m.file, number: m.number, title: m.title, blobUrl: githubBlobUrl(m.file) })),
  };
}

function buildRlsCoverage(): RlsCoverage {
  const scanned = scanRlsTables();
  if (!scanned) {
    return { status: "unavailable", note: "Could not read supabase/migrations at request time — RLS coverage unknown." };
  }
  const uncovered = MANIFEST_TABLES.filter((t) => !scanned.has(t.toLowerCase()));
  return {
    status: "scanned",
    manifestTables: MANIFEST_TABLES.length,
    rlsEnabledTables: scanned.size,
    uncoveredTables: uncovered,
    note: "Derived from `enable row level security` statements in supabase/migrations (repo truth — not a live pg_class probe). RLS enabled ≠ policy correctness; policies are defined per-table in the same migrations.",
  };
}

/* ── Live probes ────────────────────────────────────────────────────────── */

async function headCount(db: SupabaseClient, table: string): Promise<DbStat | null> {
  const meta = DB_ADMIN_TABLES.find((t) => t.table === table);
  if (!meta) return null;
  try {
    const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).limit(1);
    if (error) return { table, label: meta.label, rows: null, error: error.code ?? error.message };
    return { table, label: meta.label, rows: count ?? 0 };
  } catch (e) {
    return { table, label: meta.label, rows: null, error: e instanceof Error ? e.message.slice(0, 120) : "query failed" };
  }
}

/**
 * Full database admin report. Read-only; safe to call per request. `db === null`
 * yields an honest unconfigured report (counts empty, backup null).
 */
export async function getDatabaseAdmin(db: SupabaseClient | null): Promise<DatabaseAdminReport> {
  const checkedAt = new Date().toISOString();
  const migrations = buildMigrationInfo();
  const indexCount = scanIndexCount();
  const base = {
    configured: Boolean(db),
    checkedAt,
    migrations,
    databaseSize: {
      status: "unavailable" as const,
      note: "pg_database_size() is not exposed via PostgREST and no size RPC exists in the migrations. Check Supabase Dashboard → Database → Reports / Disk IO for live size.",
    },
    slowQueries: {
      status: "unavailable" as const,
      note: "pg_stat_statements is not reachable via PostgREST. For slow-query analysis enable/inspect it in the Supabase dashboard (Database → Query Performance) — the app never runs arbitrary SQL.",
    },
    indexHealth: indexCount == null
      ? { status: "unavailable" as const, note: "Could not scan supabase/migrations — index count unknown." }
      : {
          status: "scanned" as const,
          createIndexStatements: indexCount,
          tablesWithRls: (() => { const s = scanRlsTables(); return s ? s.size : 0; })(),
          note: `${indexCount} CREATE INDEX statements across repo migrations. Live index usage/size (pg_stat_user_indexes) is not exposed via PostgREST — see schema page for definitions.`,
        },
    rls: buildRlsCoverage(),
  };

  if (!db) {
    return {
      ...base,
      reachable: false,
      latencyMs: null,
      detail: "backend not configured (Supabase env vars absent)",
      stats: [],
      backup: null,
    };
  }

  // Cheap connectivity probe.
  const start = performance.now();
  let reachable = false;
  let detail = "probe failed";
  try {
    const { error } = await db.from("system_feature_flags").select("key", { count: "exact", head: true }).limit(1);
    reachable = !error;
    detail = error ? `probe failed: ${error.code ?? error.message}` : "select ok (system_feature_flags head count)";
  } catch (e) {
    detail = `probe failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`;
  }
  const latencyMs = Math.round(performance.now() - start);

  // Parallel bounded head counts.
  const settled = await Promise.allSettled(DB_ADMIN_TABLES.map((t) => headCount(db, t.table)));
  const stats = settled
    .map((s) => (s.status === "fulfilled" ? s.value : null))
    .filter((s): s is DbStat => s !== null);

  // Backup/retention state — reuse the security-readiness aggregate (it owns
  // the provider-snapshot state machine and retention last-run probe).
  let backup: DatabaseAdminReport["backup"] = null;
  try {
    const r = await securityReadiness(db);
    backup = {
      state: r.backup.state,
      providerSnapshot: r.backup.provider_snapshot,
      recoveryLastTest: r.recovery_last_test,
      retentionLastRun: r.retention_last_run,
      note: "Derived by securityReadiness from the last-known provider snapshot (not live) + system_recovery_tests / system_retention_runs rows. See /system/security/readiness.",
    };
  } catch {
    backup = { state: null, providerSnapshot: null, recoveryLastTest: null, retentionLastRun: null, note: "securityReadiness probe failed — backup state unknown." };
  }

  return { ...base, reachable, latencyMs, detail, stats, backup };
}

/* ── Cron run detail enrichment (jobs deep-dive) ────────────────────────── */

export type CronJobDetail = {
  job: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  /** Sanitized cron_runs.detail of the most recent run (bounded). */
  lastDetail: Record<string, unknown> | null;
  lastError: string | null;
  /** duration_ms of the most recent trace_spans row named `cron.<job>` — null when absent. */
  lastDurationMs: number | null;
  lastSpanStatus: string | null;
};

/**
 * Per-job last-run detail + observed duration for the cron table. Supplements
 * getSystemJobs (which cannot be extended here) — reads cron_runs.detail and
 * the latest `cron.<job>` trace span. All values sanitized; never throws.
 */
export async function getCronJobDetails(db: SupabaseClient | null): Promise<Map<string, CronJobDetail>> {
  const out = new Map<string, CronJobDetail>();
  if (!db) return out;
  const jobs = [...new Set(CRON_ROUTES.flatMap((r) => r.jobs))];

  try {
    const { data } = await db
      .from("cron_runs")
      .select("job,ok,ran_at,detail")
      .order("ran_at", { ascending: false })
      .limit(500);
    const rows = (data ?? []) as { job: string; ok: boolean; ran_at: string; detail: unknown }[];
    for (const job of jobs) {
      const latest = rows.find((r) => r.job === job);
      if (!latest) continue;
      const detail = latest.detail && typeof latest.detail === "object" && !Array.isArray(latest.detail)
        ? sanitizeAuditDetail(latest.detail as Record<string, unknown>)
        : null;
      const errRaw = detail && typeof detail.error === "string" ? detail.error : null;
      out.set(job, {
        job,
        lastRunAt: latest.ran_at,
        lastOk: latest.ok,
        lastDetail: detail,
        lastError: typeof errRaw === "string" ? errRaw.slice(0, 300) : null,
        lastDurationMs: null,
        lastSpanStatus: null,
      });
    }
  } catch { /* leave map empty */ }

  try {
    const names = jobs.map((j) => `cron.${j}`);
    const { data } = await db
      .from("trace_spans")
      .select("name,duration_ms,status,created_at")
      .in("name", names)
      .order("created_at", { ascending: false })
      .limit(500);
    const seen = new Set<string>();
    for (const s of (data ?? []) as { name: string; duration_ms: number; status: string; created_at: string }[]) {
      const job = s.name.startsWith("cron.") ? s.name.slice(5) : s.name;
      if (seen.has(job)) continue;
      seen.add(job);
      const e = out.get(job) ?? { job, lastRunAt: null, lastOk: null, lastDetail: null, lastError: null, lastDurationMs: null, lastSpanStatus: null };
      e.lastDurationMs = Number(s.duration_ms) || 0;
      e.lastSpanStatus = s.status;
      out.set(job, e);
    }
  } catch { /* span durations are best-effort */ }

  return out;
}
