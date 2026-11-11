import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listSecrets } from "@/lib/system/integrations";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/keys — API credential metadata for the keys page: same data
 * as /api/system/secrets minus nothing (it IS the registry: provider, env var
 * name, purpose, configured bool, rotation policy). Values are never stored
 * readable or returned. Read-only; rotation requests stay on
 * POST /api/system/secrets/rotate.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const secrets = await listSecrets(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "keys.viewed",
    resource: "secrets:registry",
    detail: { count: secrets.length },
  });
  return NextResponse.json({ keys: secrets, environment: process.env.VERCEL_ENV ?? "development" });
}
