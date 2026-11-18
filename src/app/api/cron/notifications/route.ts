import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCron } from "@/lib/fleet-sweep";
import { runSmsSweep } from "@/lib/notifications";
import { sweepNotificationEvents } from "@/lib/notify";
import { serviceClient } from "@/lib/supabase";
import { pausedJobSet, recordPausedRun } from "@/lib/system/job-controls";

/**
 * Frequent notification drain — pushes/SMS are also sent in-band when jobs queue,
 * but this sweep is the backstop for retries, future-due reminders and anything
 * queued while a channel was briefly down. Driven every 5 minutes by pg_cron
 * (migration 0089); the Vercel cron entry is the daily backstop.
 */

export async function GET(req: Request) {
  if (!(await cronAuthorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const paused = await pausedJobSet(db);
  const sms = paused.has("sms") ? await recordPausedRun(db, "sms") : await recordCron(db, "sms", async () => ({ ...(await runSmsSweep(db)) }));
  const events = paused.has("notify") ? await recordPausedRun(db, "notify") : await recordCron(db, "notify", async () => ({ ...(await sweepNotificationEvents(db)) }));
  const ok = sms.ok && events.ok;
  return NextResponse.json({ ok, sms: sms.detail, events: events.detail }, { status: ok ? 200 : 500 });
}
