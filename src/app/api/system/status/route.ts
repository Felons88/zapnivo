import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getSystemStatus } from "@/lib/system/status";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/status — technical status board. Aggregates real signals:
 * supabase probe, provider configured-bools, kiosk adapter, cron_runs ages,
 * error_events 24h, uptime_checks latest. Read-only, dashboard.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const status = await getSystemStatus(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "status.viewed",
    resource: "status:board",
    detail: { degraded: status.summary.degraded, unconfigured: status.summary.unconfigured },
  });
  return NextResponse.json(status);
}
