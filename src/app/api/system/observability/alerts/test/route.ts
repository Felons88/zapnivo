import { NextResponse } from "next/server";
import { systemApiGuard } from "../../../_shared";
import { sendTestAlert } from "@/lib/system/alert-notify";
import { roleCan } from "@/lib/system/rbac";

/**
 * POST /api/system/observability/alerts/test — send a clearly-marked test
 * alert to the configured ALERT_WEBHOOK_URL and record the result in
 * alert_notifications. This is the authorized end-to-end verification of the
 * alert destination. Mutations need system.changes.request (same as other
 * system mutations); reads need system.security.audit.view.
 *
 * Honest states: 503 when ALERT_WEBHOOK_URL is not configured; 200 with
 * delivered:false when the webhook rejected/failed.
 */
export async function POST() {
  const g = await systemApiGuard("system.security.audit.view", { limit: 10 });
  if (!g.ok) return g.res;
  if (!roleCan(g.role, "system.changes.request")) {
    return NextResponse.json({ error: "Missing permission: system.changes.request (alert test)" }, { status: 403 });
  }
  const result = await sendTestAlert(g.db, { id: g.user.id, role: g.role });
  if (!result.ok) {
    return NextResponse.json({ ok: false, configured: false, error: result.error }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    configured: true,
    delivered: result.delivered,
    httpStatus: result.status,
    notificationId: result.notificationId,
  });
}
