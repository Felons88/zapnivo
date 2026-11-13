import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getWebhookInspector } from "@/lib/system/webhook-inspector";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/infrastructure/webhooks — aggregated inbound webhook/event
 * surfaces (stripe_events, inbound_jobs, inbound_emails quarantine,
 * sms_messages, system_device_messages, email_outbox) with 24h counts,
 * pending, failures, last success, and recent sanitized events. No payloads
 * or PII are returned.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 120 });
  if (!g.ok) return g.res;
  const report = await getWebhookInspector(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "infrastructure.webhooks_viewed",
    resource: "infrastructure:webhooks",
    detail: { sources: report.sources.length, recent: report.recent.length },
  });
  return NextResponse.json({ webhooks: report });
}
