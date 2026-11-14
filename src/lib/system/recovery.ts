import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";
import {
  LAST_KNOWN_PROVIDER_SNAPSHOT,
  deriveBackupState,
  type BackupState,
  type ProviderBackupSnapshot,
} from "./readiness";

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

/* ── Backup posture (Phase 4.4) ────────────────────────────────────────── */

export type BackupPosture = {
  /** Last-known provider snapshot — a manually refreshed CLI record, NEVER live. */
  providerSnapshot: ProviderBackupSnapshot;
  /**
   * State derived via readiness.deriveBackupState from the snapshot + recorded
   * recovery tests. `recoveryVerifiedRecorded` is always false — no verified
   * marker column exists, so 'recovery_verified' is unreachable from live data.
   */
  state: BackupState;
  /** Count of recorded recovery tests; null when the table/probe failed. */
  testsTotal: number | null;
  /** Count with result='passed' — self-reported by operators. */
  testsPassed: number | null;
  /** Newest recorded test (self-reported). */
  lastTest: { result: string | null; tested_at: string | null; environment: string | null; method: string | null } | null;
  /** Always false — the snapshot is a dated record, not a live provider query. */
  snapshotIsLive: false;
  note: string;
};

/**
 * Combines the last-known provider snapshot (WAL-G/PITR/backup list from the
 * Supabase CLI — see docs/RECOVERY.md) with recorded recovery tests into one
 * posture object for /system/recovery. Provider state is NEVER queried live;
 * the snapshot carries its own as_of date and is labeled as such.
 */
export async function getBackupPosture(db: SupabaseClient | null): Promise<BackupPosture> {
  const snap = LAST_KNOWN_PROVIDER_SNAPSHOT;
  const base = {
    providerSnapshot: snap,
    snapshotIsLive: false as const,
    note: "Provider backup state comes from LAST_KNOWN_PROVIDER_SNAPSHOT — a dated, manually refreshed `supabase backups list` record (see docs/RECOVERY.md), NOT a live query. Refresh it with the CLI, then update readiness.ts.",
  };
  if (!db) {
    return {
      ...base,
      state: deriveBackupState({ pitrEnabled: snap.pitr_enabled, backupCount: snap.backup_count, recoveryTests: null, recoveryPassed: false, recoveryVerifiedRecorded: false }),
      testsTotal: null,
      testsPassed: null,
      lastTest: null,
    };
  }
  const { tests, error } = await listRecoveryTests(db, 200);
  if (error) {
    return {
      ...base,
      state: deriveBackupState({ pitrEnabled: snap.pitr_enabled, backupCount: snap.backup_count, recoveryTests: null, recoveryPassed: false, recoveryVerifiedRecorded: false }),
      testsTotal: null,
      testsPassed: null,
      lastTest: null,
    };
  }
  const testsPassed = tests.filter((t) => t.result === "passed").length;
  const latest = tests[0] ?? null;
  return {
    ...base,
    state: deriveBackupState({
      pitrEnabled: snap.pitr_enabled,
      backupCount: snap.backup_count,
      recoveryTests: tests.length,
      recoveryPassed: testsPassed > 0,
      recoveryVerifiedRecorded: false,
    }),
    testsTotal: tests.length,
    testsPassed,
    lastTest: latest
      ? { result: latest.result, tested_at: latest.tested_at, environment: latest.environment, method: latest.method }
      : null,
  };
}

/* ── Isolated restore procedure (Phase 4.4) ────────────────────────────── */

/**
 * Detailed owner runbook for restoring into an ISOLATED target before any
 * production cutover. Rendered on /system/recovery and mirrored in
 * docs/RECOVERY.md. Every step is a human/dashboard/CLI action — the app
 * performs no restore itself.
 */
export const ISOLATED_RESTORE_RUNBOOK: readonly RunbookStep[] = [
  {
    title: "1. Create the isolated target",
    detail: "Supabase Dashboard → new project in the same org (free/Pro tier is fine), or a branch of the production project if the plan supports branching. Name it clearly, e.g. zapnivo-restore-drill. This target must NEVER receive live traffic.",
  },
  {
    title: "2. Get the data across",
    detail: "Preferred: Dashboard → Database → Backups on the SOURCE project → restore into the isolated project (PITR timestamp or nearest daily backup). Alternative: owner-run `pg_dump` from production → `pg_restore`/`psql` into the isolated project's connection string (see scripts/backup-db.sh for the dump side). Auth users live in the auth schema — a plain pg_dump of public does NOT carry them; use Supabase's native restore or dashboard export for auth.",
    warning: true,
  },
  {
    title: "3. Align schema & verify migrations",
    detail: "In the isolated project run `supabase link --project-ref <new-ref>` then `supabase migration list` — every repo migration through the latest file must show as applied (or apply missing ones with `supabase db push` ONLY if the restore left the schema behind). Confirm system_* tables exist with RLS enabled.",
  },
  {
    title: "4. Point a PREVIEW deployment at it",
    detail: "In Vercel, set NEXT_PUBLIC_SUPABASE_URL / anon key / SUPABASE_SERVICE_ROLE_KEY (and any other required vars) on a PREVIEW environment or a throwaway deployment pointing at the isolated project. NEVER overwrite the production env vars for a drill.",
  },
  {
    title: "5. Validate before trusting it",
    detail: "Run the post-restore checklist in docs/RECOVERY.md: row counts on payments/rentals/profiles/system_audit_events, spot-check one known transaction, confirm auth sign-in works, spot-check RLS isolation, hit the preview deploy's health endpoint. Record elapsed wall time — that is your measured RTO; the restore-point gap is your measured RPO.",
  },
  {
    title: "6. Record the exercise, then destroy",
    detail: "Record the test on /system/recovery (environment=isolated-project, method=supabase_backup_restore|supabase_pitr|point_in_time_dump, result, measured rpo/rto minutes). Then DELETE the isolated project/branch — do not leave a stale copy of production data running.",
    warning: true,
  },
];

/* ── Independent backup strategy (UNVERIFIED) ─────────────────────────── */

export type BackupStrategyStep = { title: string; detail: string; status: "unverified" | "documented" };

/**
 * Documented independent-backup strategy. HONESTY: nothing here has been
 * executed — no encrypted dump has ever been taken and no restore from one has
 * ever succeeded. Status stays 'unverified' until the first restore test is
 * recorded with result='passed'. Do NOT cite this as a backup until then.
 */
export const INDEPENDENT_BACKUP_STRATEGY: readonly BackupStrategyStep[] = [
  {
    title: "UNVERIFIED — encrypted pg_dump on a schedule",
    detail: "Owner-run script (scripts/backup-db.sh, or a scheduled GitHub Action / operator cron — pg_dump cannot run inside Vercel serverless). Dumps the public schema (+ auth if using GoTrue export) nightly. Status: unverified — never executed.",
    status: "unverified",
  },
  {
    title: "UNVERIFIED — private destination, 3-2-1",
    detail: "Encrypted dumps go to private object storage owned separately from the database provider where feasible (owner S3 bucket / private Supabase Storage bucket / private Vercel Blob). Never a public bucket, never committed to the repo. Keep ≥3 copies across ≥2 media, 1 off-site. Status: unverified — no bucket or upload path configured.",
    status: "unverified",
  },
  {
    title: "UNVERIFIED — key separation",
    detail: "Encrypt dumps with a dedicated BACKUP_ENCRYPTION_KEY (age or GPG symmetric, or KMS). This key MUST be separate from DEVICE_CREDENTIAL_KEK and every application secret — compromise of the app must not yield readable backups. Store the key in the owner's password manager / KMS, not in Vercel env unless strictly required.",
    status: "unverified",
  },
  {
    title: "UNVERIFIED — retention policy",
    detail: "Suggested starting point (owner to finalize): daily dumps kept 35 days, weekly kept 12 weeks, monthly kept 12 months. Apply bucket lifecycle rules or manual pruning; verify the oldest retained dump is still decryptable quarterly.",
    status: "unverified",
  },
  {
    title: "UNVERIFIED — monitoring",
    detail: "The dump job must emit a heartbeat (dead-man's switch — e.g. healthchecks.io or a row in cron_runs if run from infra you control). Alert if no successful encrypted dump lands within 25 hours. A backup you are not monitoring is not a backup.",
    status: "unverified",
  },
  {
    title: "UNVERIFIED — routine restore-test cadence",
    detail: "Quarterly isolated restore drill using ISOLATED_RESTORE_RUNBOOK above, recorded in system_recovery_tests. First recorded pass moves backup.state to restore_tested (self-reported); keep drills going — an untested backup is a hypothesis, not a backup.",
    status: "unverified",
  },
];
