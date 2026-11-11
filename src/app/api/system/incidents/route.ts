import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listIncidents } from "@/lib/system/incidents";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/incidents?status=<status|open> — observability incident list.
 * Read perm: system.security.audit.view (incident data is operational/audit
 * adjacent; dashboard.view would also work but audit.view is the tighter read
 * already used by the security surfaces).
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  const { configured, rows } = await listIncidents(g.db, { status, limit: 200 });
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "incidents.viewed",
    resource: "incidents:list",
    detail: { count: rows.length, status: status ?? "all" },
  });
  return NextResponse.json({ configured, incidents: rows, environment: process.env.VERCEL_ENV ?? "development" });
}
