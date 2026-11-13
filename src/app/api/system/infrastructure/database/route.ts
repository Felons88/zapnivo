import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getDatabaseAdmin } from "@/lib/system/db-admin";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/infrastructure/database — database admin report:
 * connectivity probe, bounded head counts on key tables, repo migration/RLS
 * scans, and honest unavailable states for Postgres internals PostgREST does
 * not expose (size, pg_stat_statements, live index usage). Read-only; no
 * arbitrary SQL exists on this surface by design.
 */
export async function GET() {
  const g = await systemApiGuard("system.database.schema.view", { limit: 60 });
  if (!g.ok) return g.res;
  const report = await getDatabaseAdmin(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "infrastructure.database_viewed",
    resource: "infrastructure:database",
    detail: { reachable: report.reachable, tables: report.stats.length },
  });
  return NextResponse.json({ database: report });
}
