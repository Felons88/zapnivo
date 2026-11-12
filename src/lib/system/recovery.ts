import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Disaster-recovery surface for the system console.
 *
 * HONESTY CONTRACT: this app holds no Supabase management API token, so it
 * CANNOT verify provider-side backups, PITR status, or run a real restore.
 * Everything on this page is either (a) facts we can state truthfully, or
 * (b) placeholders explicitly marked "unverified" that a human must confirm in
 * the Supabase dashboard. `system_recovery_tests` records MANUALLY-performed
 * restore tests — the row is only as trustworthy as the operator entering it.
 */

export type RecoveryFacts = {
  /** Supabase manages physical backups; the app cannot see them. */
  backupStatus: "managed_by_provider_unverified";
  backupDetail: string;
  /** Point-in-time recovery availability — unverified until checked in dashboard. */
  pitrStatus: "unverified";
  /** Documented targets; NOT measured — fill in after a real test. */
  rpoTargetMinutes: number | null;
  rtoTargetMinutes: number | null;
  rpoNote: string;
  rtoNote: string;
  checkedAt: string;
};

export function getRecoveryFacts(): RecoveryFacts {
  return {
    backupStatus: "managed_by_provider_unverified",
    backupDetail:
      "Database backups on Supabase are managed by the provider (daily backups on Pro+ plans; PITR is a paid add-on). This app has no management API token, so backup health CANNOT be verified from here — check Dashboard → Database → Backups.",
    pitrStatus: "unverified",
    rpoTargetMinutes: null,
    rtoTargetMinutes: null,
    rpoNote: "RPO target is unverified — set after the first timed restore test and record it in a recovery test row.",
    rtoNote: "RTO target is unverified — set after the first timed restore test and record it in a recovery test row.",
    checkedAt: new Date().toISOString(),
  };
}

export type RunbookStep = { title: string; detail: string; warning?: boolean };

/** Real restore procedure for a Supabase project. Steps are provider-console based. */
export const RESTORE_RUNBOOK: readonly RunbookStep[] = [
  {
    title: "1. Freeze writes & open an incident",
    detail: "Declare an incident in this console (Incidents) and pause cron jobs / maintenance writes if the restore window requires it. Note the exact UTC time of the last known-good state.",
  },
  {
    title: "2. Choose the restore point in the Supabase dashboard",
    detail: "Dashboard → Database → Backups. For PITR plans you can restore to any timestamp; otherwise pick the nearest daily backup BEFORE the corruption event. Write down the chosen timestamp — it defines your actual RPO.",
  },
  {
    title: "3. Restore to a NEW project first (never in place first)",
    detail: "Supabase restores overwrite the project. For anything beyond a trivial test, restore into a fresh project/branch, verify row counts and critical tables (payments, rentals, profiles), THEN decide on cutover. Restoring in place is one-way.",
    warning: true,
  },
  {
    title: "4. Verify integrity before cutover",
    detail: "Compare counts on financial/audit tables (payments, stripe_events, system_audit_events, rentals), spot-check a known transaction, and confirm auth users exist. Record actual elapsed time — that is your measured RTO.",
  },
  {
    title: "5. Cut over & record the test",
    detail: "Update env vars / DNS to the restored project if a new project was used, redeploy, then record the exercise below with method, result, and measured RPO/RTO minutes.",
  },
  {
    title: "NEVER restore over production blindly",
    detail: "A restore is destructive and irreversible for data written after the restore point. Always verify on a copy first, and get a second operator to confirm the restore timestamp.",
    warning: true,
  },
];

export type RecoveryTestInput = {
  testedAt?: string;
  environment?: string;
  method?: string;
  result: "passed" | "failed" | "partial";
  rpoMinutes?: number | null;
  rtoMinutes?: number | null;
  notes?: string;
};

export type RecoveryTestRow = {
  id: string;
  tested_at: string;
  environment: string;
  method: string;
  result: "passed" | "failed" | "partial";
  rpo_minutes: number | null;
  rto_minutes: number | null;
  notes: string | null;
  actor_id: string | null;
  created_at: string;
};

const METHODS = ["supabase_backup_restore", "supabase_pitr", "point_in_time_dump", "manual_sql", "other"] as const;
export const RECOVERY_METHODS = METHODS;
export const isRecoveryMethod = (v: string) => (METHODS as readonly string[]).includes(v);

/** Lists recorded recovery tests, newest first. */
export async function listRecoveryTests(db: SupabaseClient, limit = 50): Promise<{ tests: RecoveryTestRow[]; error: string | null }> {
  const { data, error } = await db
    .from("system_recovery_tests")
    .select("id,tested_at,environment,method,result,rpo_minutes,rto_minutes,notes,actor_id,created_at")
    .order("tested_at", { ascending: false })
    .limit(limit);
  if (error) {
    // Table arrives with migration 0045 — report honestly if absent.
    if (/does not exist|relation|schema cache/i.test(error.message)) return { tests: [], error: null };
    return { tests: [], error: error.message };
  }
  return { tests: (data ?? []) as RecoveryTestRow[], error: null };
}

/**
 * Records a manually-performed recovery test. This is a MUTATION — it writes a
 * row and an audit event, but it does NOT perform or verify any restore.
 */
export async function recordRecoveryTest(
  db: SupabaseClient,
  actor: SystemActor,
  input: RecoveryTestInput,
): Promise<{ ok: true; test: RecoveryTestRow } | { ok: false; status: number; error: string }> {
  const testedAt = input.testedAt && !Number.isNaN(Date.parse(input.testedAt))
    ? new Date(input.testedAt).toISOString()
    : new Date().toISOString();
  const environment = (input.environment ?? "production").slice(0, 40);
  const method = (input.method ?? "").slice(0, 60);

  const { data, error } = await db.from("system_recovery_tests").insert({
    tested_at: testedAt,
    environment,
    method,
    result: input.result,
    rpo_minutes: input.rpoMinutes ?? null,
    rto_minutes: input.rtoMinutes ?? null,
    notes: input.notes?.slice(0, 4000) ?? null,
    actor_id: actor.id,
  }).select("id,tested_at,environment,method,result,rpo_minutes,rto_minutes,notes,actor_id,created_at").single();

  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  const row = data as RecoveryTestRow;

  await systemAudit(db, {
    actor,
    action: "recovery.test_recorded",
    resource: `recovery_test:${row.id}`,
    detail: {
      environment, method, result: input.result,
      rpo_minutes: input.rpoMinutes ?? null, rto_minutes: input.rtoMinutes ?? null,
      tested_at: testedAt,
    },
  });
  return { ok: true, test: row };
}
