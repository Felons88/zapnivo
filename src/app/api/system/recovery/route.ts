import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getRecoveryFacts, RESTORE_RUNBOOK, listRecoveryTests, RECOVERY_METHODS } from "@/lib/system/recovery";

/**
 * GET /api/system/recovery — DR facts (honest: provider backups unverifiable
 * from app), restore runbook, and recorded recovery tests.
 * Perm: system.security.audit.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { tests, error } = await listRecoveryTests(g.db, 50);
  return NextResponse.json({
    facts: getRecoveryFacts(),
    runbook: RESTORE_RUNBOOK,
    methods: RECOVERY_METHODS,
    tests,
    testsError: error,
    warning: "Backup status is managed by Supabase and CANNOT be verified from this app — confirm in the Supabase dashboard. Never restore over production without a verified copy.",
  });
}
