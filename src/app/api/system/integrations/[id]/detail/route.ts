import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { getProvider } from "@/lib/system/integrations";
import { getIntegrationDetail } from "@/lib/system/integration-detail";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/integrations/[id]/detail — full per-provider operational
 * detail: env presence, read/write authorization evidence, webhook state,
 * last operation, missing settings, permissions guidance, docs.
 *
 * Read-only, bounded queries, audited as a sensitive read. Never returns
 * secret values — env vars appear as names + presence booleans only.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!getProvider(id)) return NextResponse.json({ error: "Unknown integration" }, { status: 404 });

  const detail = await getIntegrationDetail(g.db, id);
  if (!detail) return NextResponse.json({ error: "Unknown integration" }, { status: 404 });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "integration.detail_viewed",
    resource: `integration:${id}`,
    detail: { configured: detail.provider.configured, missing: detail.missingSettings.length },
  });

  return NextResponse.json({ detail });
}
