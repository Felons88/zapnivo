import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { securityReadiness } from "@/lib/system/readiness";

/**
 * GET /api/system/security/readiness — aggregate security-readiness counts
 * (device credential modes, pending rotations, expirations, auth rejections,
 * elevations, bootstrap grants, retention/recovery status, KEK version).
 * Permission: system.security.audit.view. NEVER returns credential material.
 */
export async function GET() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 120 });
  if (!g.ok) return g.res;
  const readiness = await securityReadiness(g.db);
  return NextResponse.json(readiness);
}
