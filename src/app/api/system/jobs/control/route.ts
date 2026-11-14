import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { assertApprovedOrRequest, systemAudit } from "@/lib/system/audit";
import { CRON_ROUTES } from "@/lib/system/jobs";
import { jobControlDenied, setJobPaused } from "@/lib/system/job-controls";

const controlSchema = z.object({
  job: z.string().min(1).max(60),
  paused: z.boolean(),
  justification: z.string().max(2000).optional(),
});

/** Controllable job names = every job recorded by the vercel.json cron routes. */
const KNOWN_JOBS = [...new Set(CRON_ROUTES.flatMap((r) => r.jobs))];

/**
 * POST /api/system/jobs/control — pause/resume a vercel.json cron job.
 * Body: { job, paused, justification? }. Perm: system.webhooks.retry,
 * rate-limited 30/min.
 *
 * Gates (in order):
 *  1. RBAC permission + rate limit (systemApiGuard).
 *  2. Denylist — financial/settlement jobs → 403 (jobControlDenied).
 *  3. assertApprovedOrRequest (risk medium) — breakglass needs an approved
 *     change request; response 202 approval_required otherwise.
 *  4. setJobPaused → jobs.paused app setting (risk 'high' ⇒ fresh step-up
 *     elevation via setAppSetting) + jobs.paused/jobs.resumed audit.
 *
 * Only cron jobs are controllable — queue workers and webhooks are not.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.webhooks.retry", { limit: 30 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = controlSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const { job, paused, justification } = parsed.data;
  const action = paused ? "pause" : "resume";

  // Denylist BEFORE any change-request side effects.
  const denied = jobControlDenied(job, action);
  if (denied) {
    await systemAudit(g.db, {
      actor: { id: g.user.id, role: g.role },
      action: "jobs.control_denied",
      resource: `cron_job:${job.trim().toLowerCase()}`,
      detail: { job, action, reason: denied },
    });
    return NextResponse.json({ error: denied }, { status: 403 });
  }

  const approval = await assertApprovedOrRequest(g.db, { id: g.user.id, role: g.role }, {
    action: `jobs.${action}:${job.trim().toLowerCase()}`,
    risk: "medium",
    justification: justification ?? `${action === "pause" ? "Pause" : "Resume"} cron job '${job}' — recorded in jobs.paused; cron routes skip paused jobs.`,
  });
  if (approval.status === "pending") {
    await systemAudit(g.db, {
      actor: { id: g.user.id, role: g.role },
      action: "jobs.control_pending",
      resource: `cron_job:${job.trim().toLowerCase()}`,
      detail: { job, action, changeRequestId: approval.changeRequestId },
    });
    return NextResponse.json({ error: "approval_required", changeRequestId: approval.changeRequestId }, { status: 202 });
  }
  if (approval.status === "error") return NextResponse.json({ error: approval.error }, { status: 500 });

  const result = await setJobPaused(g.db, { id: g.user.id, role: g.role }, g.user, {
    job,
    paused,
    justification,
    knownJobs: KNOWN_JOBS,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, job: result.job, paused: result.paused, settingValue: result.settingValue });
}
