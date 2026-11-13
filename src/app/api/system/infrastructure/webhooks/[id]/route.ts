import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import {
  inspectInfraEvent,
  INFRA_WEBHOOK_SOURCES,
  type InfraWebhookSourceId,
} from "@/lib/system/webhook-inspector";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/infrastructure/webhooks/[id] — sanitized single-event detail.
 * id format: `${source}:${rowId}` (e.g. "system_device_messages:3f2c…").
 * Whitelisted columns only; jsonb detail/payload passes through
 * sanitizeAuditDetail (inbound_jobs payload shows only non-PII auth fields).
 * Returns replay eligibility metadata — execution stays on the existing
 * audited endpoints. Audited as a sensitive read.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const sep = decoded.indexOf(":");
  const source = sep > 0 ? decoded.slice(0, sep) : "";
  const rowId = sep > 0 ? decoded.slice(sep + 1) : "";
  if (!rowId || rowId.length > 100 || !(INFRA_WEBHOOK_SOURCES as readonly string[]).includes(source)) {
    return NextResponse.json({ error: "Invalid event ref — expected source:rowId" }, { status: 400 });
  }

  const result = await inspectInfraEvent(g.db, source as InfraWebhookSourceId, rowId);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "infrastructure.webhook_inspected",
    resource: `infrastructure:webhook:${source}:${rowId}`,
    detail: { found: result.ok },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ event: result.event, replay: result.replay });
}
