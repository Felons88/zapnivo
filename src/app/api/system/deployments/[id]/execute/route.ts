import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { executeDeploymentCenterRequest } from "@/lib/system/deploy-center";

/**
 * POST /api/system/deployments/[id]/execute — execute a deployment request.
 * Perm: system.deployments.manage.
 *
 * Two modes, decided honestly at runtime:
 *  - VERCEL_TOKEN+VERCEL_PROJECT_ID configured → provider execution via the
 *    Vercel API. Production additionally requires a live step-up elevation
 *    (403 step_up_required otherwise); preview requests may execute from
 *    pending|approved with manage permission only.
 *  - Not configured → the legacy manual contract: returns
 *    { status: "awaiting_manual_deploy" } with git-push/dashboard instructions.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.deployments.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const result = await executeDeploymentCenterRequest(
    g.db,
    { id: g.user.id, role: g.role },
    g.user,
    id,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json(result.result);
}
