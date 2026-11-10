import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { runInboundWorker } from "@/lib/inbound/worker";
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
  if (!serviceClient()) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const result = await runInboundWorker(50);
  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}
