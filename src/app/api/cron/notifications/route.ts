import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { recordCron } from "@/lib/fleet-sweep";
import { runSmsSweep } from "@/lib/notifications";
import { serviceClient } from "@/lib/supabase";
import { pausedJobSet, recordPausedRun } from "@/lib/system/job-controls";

/**
 * Frequent notification drain — pushes/SMS are also sent in-band when jobs queue,
 * but this sweep is the backstop for retries, future-due reminders and anything
 * queued while a channel was briefly down. Runs every 15 minutes via Vercel cron.
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
  const paused = await pausedJobSet(db);
  const sms = paused.has("sms") ? await recordPausedRun(db, "sms") : await recordCron(db, "sms", async () => ({ ...(await runSmsSweep(db)) }));
  return NextResponse.json({ ok: sms.ok, sms: sms.detail }, { status: sms.ok ? 200 : 500 });
}
