import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { RETENTION_POLICY, PRESERVED_TABLES, listRetentionRuns, isPreservedTable } from "@/lib/system/retention";

/**
 * GET /api/system/retention — retention policy + recent run history.
 * Perm: system.security.audit.view (read-only visibility for all system roles).
 */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;

  const { runs, error } = await listRetentionRuns(g.db, 20);
  return NextResponse.json({
    policy: RETENTION_POLICY.map((r) => ({
      table: r.table,
      retentionDays: r.retentionDays,
      timeColumn: r.timeColumn,
      statusFilter: r.statusColumn && r.statusValue ? `${r.statusColumn}=${r.statusValue}` : null,
      description: r.description,
      indexNote: r.indexNote,
      preserved: isPreservedTable(r.table),
    })),
    preservedTables: PRESERVED_TABLES,
    runs,
    runsError: error,
    note: "Dry-run is the default everywhere. Execute deletes are bounded per-table batches; preserved-class tables are never touched.",
  });
}
