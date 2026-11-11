import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { inspectWebhookEvent, WEBHOOK_SOURCES, type WebhookSourceId } from "@/lib/system/webhooks";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/webhooks/[id] — sanitized event inspector.
 * id format: `${source}:${rowId}` (e.g. "inbound_jobs:3f2c…"). Returns whitelisted
 * metadata columns only — payloads and PII fields (emails, phones, bodies) are
 * never selected. Audited as a sensitive read.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.integrations.view", { limit: 60 });
  if (!g.ok) return g.res;
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const sep = decoded.indexOf(":");
  const source = sep > 0 ? decoded.slice(0, sep) : "";
  const rowId = sep > 0 ? decoded.slice(sep + 1) : "";
  if (!rowId || rowId.length > 100 || !(WEBHOOK_SOURCES as readonly string[]).includes(source)) {
    return NextResponse.json({ error: "Invalid event ref — expected source:rowId" }, { status: 400 });
  }

  const result = await inspectWebhookEvent(g.db, source as WebhookSourceId, rowId);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "webhook.inspected",
    resource: `webhook:${source}:${rowId}`,
    detail: { found: result.ok },
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ event: result.event });
}
