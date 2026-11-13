import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { runAggregation } from "@/lib/analytics-aggregates";
import { recordCron } from "@/lib/fleet-sweep";
import { recordLog, traced } from "@/lib/observability";

/**
 * Analytics aggregation job. Re-rolls the last N days of business_events into
 * analytics_daily + analytics_cohorts. Idempotent — safe to re-run.
 * Auth: Bearer CRON_SECRET or staff session.
 */
async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want));
}

export async function GET(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const staff = await import("@/lib/auth").then((m) => m.getSessionUser().then((u) => m.isStaff(u))).catch(() => false);
  if (!(await authorized(req)) && !staff) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const days = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get("days") ?? "2", 10) || 2, 1), 30);
  // recordCron writes cron_runs and emails staff on failure — a broken
  // aggregation is never silent (D3).
  const cron = await recordCron(db, "analytics", async () => {
    const results = await traced("cron.analytics", null, () => runAggregation(db, days), { days });
    return { days: results };
  });
  if (!cron.ok) {
    recordLog("error", "analytics_aggregate_failed", { service: "analytics", attrs: { err: String((cron.detail as { error?: string }).error ?? "unknown").slice(0, 200) } });
    return NextResponse.json({ error: "Aggregation failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, days: (cron.detail as { days: unknown }).days });
}
