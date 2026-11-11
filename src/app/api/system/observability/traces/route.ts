import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { listTraceSpans, groupTraces } from "@/lib/system/obs-extra";

/**
 * GET /api/system/observability/traces?hours=24&limit=300&groups=50
 * Recent trace_spans grouped by trace_id (system.security.audit.view). Read-only.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const limit = Number(url.searchParams.get("limit") ?? "300");
  const groups = Number(url.searchParams.get("groups") ?? "50");
  const spans = await listTraceSpans(g.db, {
    hours: Number.isFinite(hours) ? hours : 24,
    limit: Number.isFinite(limit) ? limit : 300,
  });
  return NextResponse.json({
    configured: true,
    windowHours: Math.min(Math.max(Number.isFinite(hours) ? hours : 24, 1), 168),
    spanCount: spans.length,
    traces: groupTraces(spans, Number.isFinite(groups) ? groups : 50),
  });
}
