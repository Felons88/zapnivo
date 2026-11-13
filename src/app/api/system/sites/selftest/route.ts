import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { runCmsSelftest } from "@/lib/system/cms-selftest";

/**
 * POST /api/system/sites/selftest — CMS acceptance self-test.
 *
 * Perm: system.flags.manage. Every role holding system.deployments.manage
 * (developer, engineer, sysadmin, breakglass) also holds flags.manage, so the
 * single-permission guard covers the required set without a second check.
 *
 * Runs a REAL zero-change publish cycle on a safe field (same-value draft →
 * publish → DB verify → restore prior revision) plus a '<script>' validation
 * probe that must be rejected before any write. See
 * src/lib/system/cms-selftest.ts for the guarantees. Audited as 'cms.selftest'.
 */
export async function POST() {
  const g = await systemApiGuard("system.flags.manage", { limit: 10, windowMs: 60_000 });
  if (!g.ok) return g.res;

  const result = await runCmsSelftest(g.db, { id: g.user.id, role: g.role });
  // 200 even on step failure — the step list IS the diagnostic result.
  return NextResponse.json(result, { status: 200 });
}
