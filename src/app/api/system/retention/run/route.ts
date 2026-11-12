import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { runRetention, getRetentionRule, isPreservedTable } from "@/lib/system/retention";
import { assertApprovedOrRequest } from "@/lib/system/audit";

const runSchema = z.object({
  mode: z.enum(["dry_run", "execute"]).default("dry_run"),
  table: z.string().max(80).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  justification: z.string().max(2000).optional(),
});

/**
 * POST /api/system/retention/run — trigger a retention sweep.
 * Perm: system.deployments.manage — chosen as the closest engineer-scoped
 * MANAGE permission in SYSTEM_PERMISSIONS (there is no system.retention.manage;
 * system.ai.manage would be wrong, and view-only perms can't mutate).
 *
 * dry_run needs no approval. execute is gated through assertApprovedOrRequest
 * at risk 'high' so production deletes always require an approved change
 * request decided by a different principal (or breakglass's standing rule).
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = runSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const { mode, table, limit, justification } = parsed.data;
  const dryRun = mode !== "execute";

  if (table) {
    if (isPreservedTable(table)) {
      return NextResponse.json({ error: `refused: ${table} is in the preserved class — never auto-deleted` }, { status: 400 });
    }
    if (!getRetentionRule(table)) {
      return NextResponse.json({ error: `unknown retention table: ${table}` }, { status: 400 });
    }
  }

  const actor = { id: g.user.id, role: g.role };

  if (!dryRun) {
    const gate = await assertApprovedOrRequest(g.db, actor, {
      action: `retention.execute${table ? `:${table}` : ""}`,
      risk: "high",
      justification: justification?.trim() || `Automated retention execute sweep${table ? ` on ${table}` : " (all telemetry tables)"}`,
    });
    if (gate.status === "pending") {
      return NextResponse.json({ status: "pending_approval", changeRequestId: gate.changeRequestId, message: "Execute requires an approved change request — a pending request was created." }, { status: 202 });
    }
    if (gate.status === "rejected") {
      return NextResponse.json({ error: "A previous change request for this action was rejected", changeRequestId: gate.changeRequestId }, { status: 409 });
    }
    if (gate.status === "error") {
      return NextResponse.json({ error: gate.error }, { status: 500 });
    }
  }

  const report = await runRetention(g.db, {
    dryRun,
    table,
    limit,
    actor,
  });

  if (!report.ok && report.results.length === 0) {
    return NextResponse.json({ error: report.error ?? "retention run failed" }, { status: 500 });
  }
  return NextResponse.json({ report }, { status: report.ok ? 200 : 207 });
}
