import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { listWebhookSources } from "@/lib/system/webhooks";
import { systemAudit } from "@/lib/system/audit";

/**
 * GET /api/system/webhooks — aggregated stats across the real webhook/event
 * tables (stripe_events, inbound_emails, inbound_jobs, sms_messages,
 * kiosk_events). Counts/statuses only — no payloads.
 */
export async function GET() {
  const g = await systemApiGuard("system.integrations.view", { limit: 120 });
  if (!g.ok) return g.res;
  const sources = await listWebhookSources(g.db);
  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "webhooks.viewed",
    resource: "webhooks:sources",
    detail: { count: sources.length },
  });
  return NextResponse.json({ sources });
}
