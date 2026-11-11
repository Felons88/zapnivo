import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getSystemJobs } from "@/lib/system/jobs";

/**
 * GET /api/system/jobs — real queue/worker visibility: email_outbox,
 * inbound_jobs, notification_jobs, cron run history (cron_runs), and
 * observability backlog. Pause/resume is reported as not_supported.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const report = await getSystemJobs(g.db);
  return NextResponse.json({ jobs: report });
}
