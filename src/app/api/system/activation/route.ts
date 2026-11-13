import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { activationProbe } from "@/lib/system/activation";

/**
 * GET /api/system/activation — per-provider activation probe.
 *
 * Perm: system.dashboard.view (read-only; every system role). Returns env
 * presence, credential-verification evidence, webhook state, last operation,
 * and the exact owner action per provider. NEVER returns secret values —
 * env vars reduce to names + booleans, health details are scrubbed upstream.
 */
export async function GET() {
  const g = await systemApiGuard("system.dashboard.view", { limit: 120 });
  if (!g.ok) return g.res;
  const probe = await activationProbe(g.db);
  return NextResponse.json(probe);
}
