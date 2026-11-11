import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { getDeploymentInfo, getEnvironmentMatrix, getRouteSurfaces } from "@/lib/system/appinfra";

/**
 * GET /api/system/app/env — environment matrix (names + presence booleans,
 * nonsecret flag values only) plus deployment info and the route-surface
 * registry. Reveals the config surface, so the read is audit-logged.
 * Requires system.deployments.view.
 */
export async function GET() {
  const g = await systemApiGuard("system.deployments.view", { limit: 60 });
  if (!g.ok) return g.res;
  const env = getEnvironmentMatrix();
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "app.env.viewed",
    resource: "app:environment",
    detail: { variables: env.length, configured: env.filter((e) => e.configured).length },
  });
  return NextResponse.json({
    environment: process.env.VERCEL_ENV ?? "development",
    deployment: getDeploymentInfo(),
    variables: env,
    routeSurfaces: getRouteSurfaces(),
  });
}
