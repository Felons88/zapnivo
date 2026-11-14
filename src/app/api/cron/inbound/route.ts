import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { runInboundWorker } from "@/lib/inbound/worker";
import { recordCron } from "@/lib/fleet-sweep";
import { pausedJobSet, recordPausedRun } from "@/lib/system/job-controls";
import { serviceClient } from "@/lib/supabase";

/**
 * Durable inbound-email worker (Stage B). Drains the inbound_jobs queue:
 * verifies reply tokens, matches tickets, dedupes, reopens threads, runs the
 * normal helpdesk pipeline. Authorized by CRON_SECRET (Vercel cron) or a
 * signed-in staff user ("Run now" from the admin UI).
 */
async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret ?? ""}`;
  if (secret && bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want))) return true;
  return isStaff(await getSessionUser());
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  // Staff-only dead-letter retry: ?retry=dead requeues dead jobs once, then drains.
  let requeued = 0;
  if (new URL(req.url).searchParams.get("retry") === "dead") {
    const { data } = await db.from("inbound_jobs")
      .update({ status: "queued", attempts: 0, run_after: new Date().toISOString(), last_error: null })
      .eq("status", "dead").select("id");
    requeued = data?.length ?? 0;
  }

  // Operator pause (jobs.paused): a paused inbound worker records a skipped
  // cron_runs row; queued jobs simply wait. Fail-open when unset.
  const result = (await pausedJobSet(db)).has("inbound")
    ? await recordPausedRun(db, "inbound")
    : await recordCron(db, "inbound", async () => {
        const r = await runInboundWorker(50);
        if (r.errors.length) throw new Error(`${r.errors.length} job(s) failed: ${r.errors[0]?.slice(0, 120)}`);
        return { ...r, requeued };
      });
  return NextResponse.json(result);
}
