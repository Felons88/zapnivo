import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { setAppSetting } from "./app-settings";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Cron job pause/resume controls (Phase 4.4).
 *
 * Mechanism: the whitelisted app setting `jobs.paused` (system_app_settings,
 * migration 0065 — risk 'high', string kind) holds a comma-separated list of
 * paused cron job names. Every /api/cron/* route calls pausedJobSet() after
 * auth and records a skipped cron_runs row instead of running paused jobs.
 * There is no way to pause queue workers or provider webhooks here — only the
 * five vercel.json cron routes consult the flag.
 *
 * Safety:
 *  - Financial/settlement jobs are DENYLISTED for pause/resume/retry
 *    (jobControlDenied) — they can never be controlled from this surface.
 *  - Writes go through setAppSetting → registry validation + secret scan +
 *    step-up elevation (risk 'high' ⇒ requireElevation, ≤15 min) + audit.
 *    The route additionally gates with assertApprovedOrRequest so breakglass
 *    mutations still need an approved change request.
 *  - Reads fail OPEN to "not paused" when the settings table is unavailable
 *    (migration not applied) — pausing is an operator convenience, never a
 *    safety gate, so a missing table must not silently stop production cron.
 */

export const JOBS_PAUSED_KEY = "jobs.paused";

/** Job names that must NEVER be paused/resumed/retried from this console —
 *  financial settlement, payouts, billing, ledgers, and anything Stripe- or
 *  money-movement-adjacent. Matched case-insensitively against the job name. */
const FINANCIAL_JOB = /stripe|payout|settlement|payment|refund|billing|charge|ledger|finance|invoice|salary/i;
/** Retry is stricter: destructive jobs (retention deletes rows) are also denied. */
const RETRY_DENYLIST = /stripe|payout|settlement|payment|refund|billing|charge|ledger|finance|invoice|salary|retention|destructive|purge/i;

export type JobControlAction = "pause" | "resume" | "retry";

/**
 * Pure denylist check. Returns a human-readable denial reason, or null when
 * the action is allowed for this job name. Exported for tests and routes.
 */
export function jobControlDenied(job: string, action: JobControlAction): string | null {
  const name = job.trim().toLowerCase();
  if (action === "retry" ? RETRY_DENYLIST.test(name) : FINANCIAL_JOB.test(name)) {
    return `job '${job}' is denylisted for ${action} — financial/settlement or destructive jobs are never controlled from the system console`;
  }
  return null;
}

/** Parses the stored `jobs.paused` value (comma-separated names) into a Set. */
export function parsePausedJobsValue(value: unknown): Set<string> {
  if (typeof value !== "string" || !value.trim()) return new Set();
  return new Set(
    value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Reads the paused-job set. Returns an empty set when the backend/table is
 * unavailable or the value is malformed — fail-open by design (see header).
 */
export async function pausedJobSet(db: SupabaseClient | null | undefined): Promise<Set<string>> {
  if (!db) return new Set();
  try {
    const { data, error } = await db
      .from("system_app_settings")
      .select("value")
      .eq("key", JOBS_PAUSED_KEY)
      .maybeSingle();
    if (error || !data) return new Set();
    return parsePausedJobsValue((data as { value?: unknown }).value);
  } catch {
    return new Set();
  }
}

/** Single-job convenience wrapper around pausedJobSet. */
export async function isJobPaused(db: SupabaseClient | null | undefined, job: string): Promise<boolean> {
  return (await pausedJobSet(db)).has(job.trim().toLowerCase());
}

/**
 * Records a skipped cron_runs row for a paused job so the Jobs console shows
 * the schedule was evaluated honestly (detail.paused = true) instead of
 * looking like the job silently vanished. Never throws.
 */
export async function recordPausedRun(
  db: SupabaseClient,
  job: string,
): Promise<{ ok: true; detail: { paused: true; reason: string } }> {
  const detail = { paused: true as const, reason: "operator_pause" };
  try {
    await db.from("cron_runs").insert({ job, ok: true, detail });
  } catch { /* audit-adjacent telemetry must never break the route */ }
  return { ok: true, detail };
}

export type SetJobPausedResult =
  | { ok: true; job: string; paused: boolean; settingValue: string }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Pause/resume one cron job. `knownJobs` is the caller-supplied allowlist of
 * controllable job names (the route builds it from CRON_ROUTES so this module
 * stays a leaf — jobs.ts imports THIS file for pausedJobSet).
 *
 * Order: known-job check → denylist → read-modify-write the jobs.paused
 * setting via setAppSetting (registry + elevation + app_setting.updated
 * audit) → jobs.paused/jobs.resumed audit with actor + justification.
 */
export async function setJobPaused(
  db: SupabaseClient | null | undefined,
  actor: SystemActor,
  user: SessionUser | null,
  input: { job: string; paused: boolean; justification?: string; knownJobs: readonly string[] },
): Promise<SetJobPausedResult> {
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  const job = String(input.job ?? "").trim().toLowerCase();
  if (!job || job.length > 60 || !/^[a-z0-9_-]+$/.test(job)) {
    return { ok: false, status: 400, error: "Invalid job name" };
  }
  if (!input.knownJobs.map((j) => j.toLowerCase()).includes(job)) {
    return { ok: false, status: 400, error: `Unknown cron job '${job}' — only vercel.json cron jobs are controllable` };
  }
  const denied = jobControlDenied(job, input.paused ? "pause" : "resume");
  if (denied) return { ok: false, status: 403, error: denied };

  const current = await pausedJobSet(db);
  const next = new Set(current);
  if (input.paused) next.add(job); else next.delete(job);
  const value = [...next].sort().join(",").slice(0, 480);
  const changed = input.paused ? !current.has(job) : current.has(job);

  if (changed) {
    const res = await setAppSetting(db, actor, user, { key: JOBS_PAUSED_KEY, value });
    if (!res.ok) {
      return { ok: false, status: res.status, error: res.error, code: res.code };
    }
  }

  await systemAudit(db, {
    actor,
    action: input.paused ? "jobs.paused" : "jobs.resumed",
    resource: `cron_job:${job}`,
    detail: {
      job,
      paused: input.paused,
      changed,
      pausedJobs: value || null,
      justification: input.justification?.slice(0, 500) ?? null,
    },
  });
  return { ok: true, job, paused: input.paused, settingValue: value };
}
