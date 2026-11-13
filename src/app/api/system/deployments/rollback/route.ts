import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { requestRollback, rollbackCompatibility } from "@/lib/system/deploy-center";

/**
 * GET /api/system/deployments/rollback — migration-compatibility context for
 * the rollback UI: repo manifest truth, whether a migration-tracking table is
 * queryable, and the unconditional "rollback does not revert migrations"
 * warning. Perm: system.deployments.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 120 });
  if (!g.ok) return g.res;
  const compat = await rollbackCompatibility(g.db);
  return NextResponse.json({ compat });
}

const schema = z.object({
  deploymentId: z.string().min(4).max(100),
  justification: z.string().min(10).max(4000),
  // Explicit operator acknowledgement that rollback does NOT revert database
  // migrations — the UI checkbox maps to this; it is never auto-checked.
  acknowledgeMigrationRisk: z.literal(true),
});

/**
 * POST /api/system/deployments/rollback — approval-gated rollback request.
 * Perm: system.deployments.manage. High risk → change-request approval.
 * `acknowledgeMigrationRisk` must be literally true — rollbacks never revert
 * database migrations and the operator must confirm they understand that.
 * When Vercel is configured the target must be an eligible rollback candidate
 * (a previous READY production deployment, not the current one). When
 * unconfigured the request is still recorded and resolved manually.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error: "Invalid request — acknowledgeMigrationRisk must be true (rollback does not revert database migrations)",
      issues: parsed.error.issues,
    }, { status: 400 });
  }

  const actor = { id: g.user.id, role: g.role };
  const result = await requestRollback(g.db, actor, {
    deploymentId: parsed.data.deploymentId,
    justification: parsed.data.justification,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (result.status === "pending_approval") {
    return NextResponse.json({ status: "pending_approval", changeRequestId: result.changeRequestId, migrationWarning: result.migrationWarning, message: "Rollback is high-risk — a change request was created and must be approved by a different principal first." }, { status: 202 });
  }
  return NextResponse.json({ status: "created", requestId: result.requestId, migrationWarning: result.migrationWarning }, { status: 201 });
}
