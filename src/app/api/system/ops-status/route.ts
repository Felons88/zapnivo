import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { getOpsStatus } from "@/lib/system/ops-status";

/**
 * GET /api/system/ops-status — per-subsystem integration readiness cards.
 * Perm: system.dashboard.view. States reflect recorded evidence only;
 * 'operational' is never emitted without a passing live/recorded check.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view");
  if (!g.ok) return g.res;
  return NextResponse.json(await getOpsStatus(g.db));
}
