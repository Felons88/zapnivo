import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listSecrets } from "@/lib/system/integrations";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/secrets — credential METADATA only: provider, env var name,
 * purpose, configured boolean, rotation policy, last rotation request.
 * Secret values are never stored server-side-readable here and never returned.
 * Audited as a sensitive read.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const secrets = await listSecrets(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "secrets.viewed",
    resource: "secrets:registry",
    detail: { count: secrets.length },
  });
  return NextResponse.json({ secrets, environment: process.env.VERCEL_ENV ?? "development" });
}
