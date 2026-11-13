import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Automated data retention (system.zapnivo.com → Settings → Retention).
 *
 * The policy is CODE-DEFINED here — the DB stores only run history. Two classes:
 *
 *  TELEMETRY  — high-volume operational data safe to age out. Bounded deletes
 *               only: every sweep selects at most `limit` ids older than the
 *               per-table cutoff, then deletes by primary key. Never touches
 *               rows newer than the cutoff.
 *
 *  PRESERVED  — audit, legal, financial, security and identity data. NEVER
 *               auto-deleted. `isPreservedTable()` is checked before ANY delete
 *               and again per-rule, so even an explicit `table=` request for a
 *               preserved table is refused.
 *
 * Honest limits: deletes run through the service role row-by-row in batches;
 * there is no partition/drop — very large backlogs drain over successive runs.
 */

export type RetentionRule = {
  table: string;
  /** Days a row may live before it is eligible for deletion. */
  retentionDays: number;
  /** Timestamp column the cutoff applies to (names differ per table). */
  timeColumn: string;
  /** Optional status equality filter (e.g. only finished queue rows). */
  statusColumn?: string;
  statusValue?: string;
  /** Optional multi-value status filter (terminal states like failed+cancelled). */
  statusValues?: readonly string[];
  description: string;
  /** Whether a covering time-column index exists (from migrations). */
  indexNote: string;
};

export const RETENTION_POLICY: readonly RetentionRule[] = [
  { table: "error_events", retentionDays: 30, timeColumn: "occurred_at",
    description: "Raw error reports. Aggregated fingerprints live in error_issues (preserved).",
    indexNote: "error_events_time_idx (occurred_at desc) — 0026" },
  { table: "app_logs", retentionDays: 30, timeColumn: "ts",
    description: "Application log lines (already scrubbed at write time).",
    indexNote: "app_logs_ts_idx (ts desc) — 0026" },
  { table: "trace_spans", retentionDays: 14, timeColumn: "created_at",
    description: "Distributed-trace span rows; shortest window — highest volume.",
    indexNote: "trace_spans_time_idx (created_at desc) — 0026" },
  { table: "cron_runs", retentionDays: 90, timeColumn: "ran_at",
    description: "Scheduled-job run history (status surface keeps 24h views).",
    indexNote: "cron_runs_ran_at_idx added in 0045" },
  { table: "uptime_checks", retentionDays: 90, timeColumn: "checked_at",
    description: "Synthetic uptime probe results.",
    indexNote: "uptime_checks_checked_at_idx added in 0045" },
  { table: "system_device_messages", retentionDays: 90, timeColumn: "received_at",
    description: "Device auth-telemetry messages (table arrives with migration 0044; skipped if absent).",
    indexNote: "conditional received_at index in 0045 if table exists" },
  { table: "ai_agent_runs", retentionDays: 180, timeColumn: "created_at",
    description: "AI agent run metadata (prompts/costs, no raw content).",
    indexNote: "ai_agent_runs_created_idx — 0029" },
  { table: "inbound_jobs", retentionDays: 90, timeColumn: "created_at",
    statusColumn: "status", statusValue: "done",
    description: "Finished inbound-queue jobs only; queued/processing/failed rows are kept for ops.",
    indexNote: "inbound_jobs_created_idx — 0023" },
  { table: "email_outbox", retentionDays: 90, timeColumn: "created_at",
    statusColumn: "status", statusValue: "sent",
    description: "Sent transactional email rows only; queued/failed rows are kept for ops.",
    indexNote: "outbox_status_idx (status, created_at) — 0004" },
  // ── Phase 2.7: high-volume operational telemetry ──────────────────────
  // device_events / kiosk_events are operational hardware logs, NOT legal or
  // financial records — but they may be dispute-relevant, so they get the LONG
  // window (365d), never a short one. Bounded batches drain backlogs over runs.
  { table: "device_events", retentionDays: 365, timeColumn: "occurred_at",
    description: "Immutable hardware event log (ingest payloads). Long window — possible rental-dispute evidence; not preserved-class.",
    indexNote: "device_events_kiosk_idx (kiosk_id, occurred_at desc) — 0001" },
  { table: "kiosk_events", retentionDays: 365, timeColumn: "received_at",
    description: "Device event processing ledger (replay protection + results). Long window — audit-relevant ops data.",
    indexNote: "kiosk_events_kiosk_idx (kiosk_id, received_at desc) + partial unprocessed idx — 0015" },
  { table: "business_events", retentionDays: 180, timeColumn: "occurred_at",
    description: "First-party analytics event stream; daily rollups live in analytics_daily/analytics_cohorts (preserved aggregates).",
    indexNote: "business_events_occurred_idx (occurred_at desc) — 0025" },
  { table: "inbound_emails", retentionDays: 180, timeColumn: "created_at",
    description: "Inbound-email processing log for the Communication Center (all statuses are terminal log rows).",
    indexNote: "inbound_emails_created_idx (created_at desc) — 0022" },
  { table: "sms_messages", retentionDays: 365, timeColumn: "created_at",
    description: "SMS message log (Twilio). Long window — carrier-billing/dispute evidence; contains phone numbers, kept service-role only.",
    indexNote: "sms_messages_created_idx (created_at desc) — 0012" },
  { table: "ad_events", retentionDays: 365, timeColumn: "occurred_at",
    description: "Verified ad engagement events — advertiser billing evidence; long window.",
    indexNote: "ad_events_campaign_idx (campaign_id, kind, occurred_at desc) — 0027" },
  { table: "notification_jobs", retentionDays: 90, timeColumn: "created_at",
    statusColumn: "status", statusValues: ["failed", "cancelled"],
    description: "Terminal-failure SMS schedule jobs only. 'sent' rows are KEPT — they are the (rental_id, kind) dedupe record that prevents re-sends; queued/sending are live work.",
    indexNote: "notification_jobs_due_idx (status, due_at) — 0013; created_at unindexed (small terminal volume)" },
];

/**
 * PRESERVED class — NEVER auto-deleted by this module. Audit, legal, financial,
 * security, identity and customer-support records. This is a denylist checked at
 * runtime in addition to the code-defined policy allowlist.
 */
export const PRESERVED_TABLES: readonly string[] = [
  // system control plane
  "system_audit_events", "system_change_requests", "system_retention_runs",
  "system_recovery_tests", "system_deployment_requests",
  "system_feature_flags", "system_devices", "system_device_commands",
  // incidents & aggregated error state
  "incidents", "error_issues",
  // money: payments, refunds, ledgers, disputes, payouts, promos
  "payments", "refunds", "refund_requests", "stripe_events", "disputes",
  "commission_ledgers", "payout_records", "promo_codes", "promo_redemptions",
  "billing_ledger", "billing_events", "monetization_events",
  // legal / consent / privacy
  "legal_documents", "legal_acceptances", "customer_consents", "data_requests",
  // identity & access
  "profiles", "auth_sessions", "phone_claims", "phone_otps", "sms_opt_outs",
  // customer-facing records of value
  "rentals", "support_tickets", "support_messages", "ticket_events",
  "organizations", "venues", "partner_agreements", "partner_applications",
  "audit_logs", "system_config",
];

const PRESERVED = new Set(PRESERVED_TABLES);
const RULES = new Map(RETENTION_POLICY.map((r) => [r.table, r]));

export const isPreservedTable = (table: string) => PRESERVED.has(table);
export const getRetentionRule = (table: string) => RULES.get(table) ?? null;

export type RetentionRunOptions = {
  /** Default true — dry runs count but delete nothing. */
  dryRun?: boolean;
  /** Restrict the sweep to one policy table. */
  table?: string;
  /** Per-table batch cap (ids selected per sweep). Default 500, max 5000. */
  limit?: number;
  actor?: SystemActor | null;
};

export type TableRetentionResult = {
  table: string;
  retentionDays: number;
  cutoff: string;
  /** Rows eligible (older than cutoff + status filter). */
  matched: number;
  /** Rows actually deleted (0 in dry-run). */
  deleted: number;
  dryRun: boolean;
  /** True when the table doesn't exist yet (e.g. 0044 not applied). */
  skipped?: boolean;
  error?: string;
};

export type RetentionReport = {
  ok: boolean;
  dryRun: boolean;
  policy: string;
  startedAt: string;
  durationMs: number;
  results: TableRetentionResult[];
  /** system_retention_runs row id, when the insert succeeded. */
  runId: string | null;
  error?: string;
};

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 500;

function applyFilters(q: any, rule: RetentionRule, cutoff: string) {
  q = q.lt(rule.timeColumn, cutoff);
  if (rule.statusColumn && rule.statusValues?.length) q = q.in(rule.statusColumn, [...rule.statusValues]);
  else if (rule.statusColumn && rule.statusValue) q = q.eq(rule.statusColumn, rule.statusValue);
  return q;
}

async function sweepTable(db: SupabaseClient, rule: RetentionRule, opts: Required<Pick<RetentionRunOptions, "dryRun" | "limit">>): Promise<TableRetentionResult> {
  const cutoffDate = new Date(Date.now() - rule.retentionDays * 86_400_000);
  const cutoff = cutoffDate.toISOString();
  const base = { table: rule.table, retentionDays: rule.retentionDays, cutoff, dryRun: opts.dryRun };

  // Denylist first — preserved tables can never be swept even if a rule existed.
  if (PRESERVED.has(rule.table)) {
    return { ...base, matched: 0, deleted: 0, error: `refused: ${rule.table} is in the preserved class` };
  }

  try {
    if (opts.dryRun) {
      // Exact count, no rows transferred.
      const { count, error } = await applyFilters(
        db.from(rule.table).select("id", { count: "exact", head: true }), rule, cutoff,
      );
      if (error) {
        const missing = /does not exist|relation|schema cache/i.test(error.message);
        return { ...base, matched: 0, deleted: 0, ...(missing ? { skipped: true } : {}), error: error.message };
      }
      return { ...base, matched: count ?? 0, deleted: 0 };
    }

    // Execute: bounded id select → delete by primary key.
    const { data: rows, error: selErr } = await applyFilters(
      db.from(rule.table).select("id").limit(opts.limit), rule, cutoff,
    );
    if (selErr) {
      const missing = /does not exist|relation|schema cache/i.test(selErr.message);
      return { ...base, matched: 0, deleted: 0, ...(missing ? { skipped: true } : {}), error: selErr.message };
    }
    const ids = ((rows ?? []) as { id: string | number }[]).map((r) => r.id);
    if (ids.length === 0) return { ...base, matched: 0, deleted: 0 };

    const { error: delErr } = await db.from(rule.table).delete().in("id", ids);
    if (delErr) return { ...base, matched: ids.length, deleted: 0, error: delErr.message };
    return { ...base, matched: ids.length, deleted: ids.length };
  } catch (e) {
    return { ...base, matched: 0, deleted: 0, error: e instanceof Error ? e.message.slice(0, 300) : "unknown error" };
  }
}

/**
 * Runs one retention sweep. Defaults to dry-run — callers must opt into execute.
 * Always records a system_retention_runs row (best-effort) plus audit + log.
 */
export async function runRetention(db: SupabaseClient | null | undefined, opts: RetentionRunOptions = {}): Promise<RetentionReport> {
  const startedAt = new Date();
  const dryRun = opts.dryRun !== false;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const report: RetentionReport = {
    ok: true, dryRun, policy: "standard", startedAt: startedAt.toISOString(),
    durationMs: 0, results: [], runId: null,
  };

  // Resolve rules: single-table request or the whole telemetry policy.
  let rules: RetentionRule[];
  if (opts.table) {
    if (PRESERVED.has(opts.table)) {
      report.ok = false;
      report.error = `refused: ${opts.table} is in the preserved class and is never auto-deleted`;
      rules = [];
    } else {
      const rule = RULES.get(opts.table);
      if (!rule) {
        report.ok = false;
        report.error = `unknown retention table: ${opts.table}`;
        rules = [];
      } else {
        rules = [rule];
      }
    }
  } else {
    rules = [...RETENTION_POLICY];
  }

  if (db && rules.length) {
    for (const rule of rules) {
      report.results.push(await sweepTable(db, rule, { dryRun, limit }));
    }
  } else if (!db) {
    report.ok = false;
    report.error = "backend not configured";
  }

  // A sweep is "ok" when nothing hard-failed; missing/skipped tables are honest
  // no-ops (e.g. system_device_messages before migration 0044 is applied).
  const hardErrors = report.results.filter((r) => r.error && !r.skipped);
  report.ok = !report.error && hardErrors.length === 0;

  report.durationMs = Date.now() - startedAt.getTime();

  // Persist the run row (best-effort — never let bookkeeping break the sweep).
  if (db) {
    const deletedCounts: Record<string, number> = {};
    for (const r of report.results) deletedCounts[r.table] = r.deleted;
    const cutoffs = report.results.map((r) => r.cutoff).sort();
    const { data: runRow, error: runErr } = await db.from("system_retention_runs").insert({
      policy: report.policy,
      mode: dryRun ? "dry_run" : "execute",
      cutoff: cutoffs[0] ?? null,
      tables: report.results.map((r) => r.table),
      deleted_counts: deletedCounts,
      duration_ms: report.durationMs,
      status: report.ok ? "completed" : "partial",
      error: report.error ?? (hardErrors.length ? hardErrors.map((r) => `${r.table}: ${r.error}`).join("; ").slice(0, 1000) : null),
    }).select("id").single();
    if (!runErr && runRow) report.runId = (runRow as { id: string }).id;
  }

  await systemAudit(db, {
    actor: opts.actor ?? null,
    action: dryRun ? "retention.dry_run" : "retention.execute",
    resource: "retention:standard",
    detail: {
      tables: report.results.map((r) => `${r.table}:${r.deleted}${r.skipped ? ":skipped" : ""}`).join(","),
      matched: report.results.reduce((a, r) => a + r.matched, 0),
      deleted: report.results.reduce((a, r) => a + r.deleted, 0),
      duration_ms: report.durationMs,
      error: report.error ?? undefined,
    },
  });
  recordLog(report.ok ? "info" : "warning", `retention.${dryRun ? "dry_run" : "execute"}`, {
    service: "system",
    attrs: { deleted: report.results.reduce((a, r) => a + r.deleted, 0), tables: report.results.length },
  });

  return report;
}

/** History helper for the API/page — newest runs first. */
export async function listRetentionRuns(db: SupabaseClient, limit = 20) {
  const { data, error } = await db
    .from("system_retention_runs")
    .select("id,policy,mode,cutoff,tables,deleted_counts,duration_ms,status,error,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { runs: [] as Record<string, unknown>[], error: error.message };
  return { runs: (data ?? []) as Record<string, unknown>[], error: null };
}
