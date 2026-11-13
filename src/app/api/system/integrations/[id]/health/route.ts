import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { checkIntegrationHealth, getProvider } from "@/lib/system/integrations";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/integrations/[id]/health — one bounded (5s), read-only live
 * check. Only providers with an existing API client in this repo are called;
 * others return unconfigured / requires_credentials / not_verified honestly.
 * Audited as a sensitive read.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.integrations.view", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!getProvider(id)) return NextResponse.json({ error: "Unknown integration" }, { status: 404 });

  const health = await checkIntegrationHealth(id, g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "integration.health_checked",
    resource: `integration:${id}`,
    detail: { status: health?.status, latencyMs: health?.latencyMs, detail: health?.detail?.slice(0, 200) ?? null },
  });
  return NextResponse.json({ health });
}
