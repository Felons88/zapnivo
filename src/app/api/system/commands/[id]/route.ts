import { NextResponse } from "next/server";
import { systemApiGuard } from "../../_shared";
import { getCommandDetail } from "@/lib/system/command-ops";

export const dynamic = "force-dynamic";

/**
 * GET /api/system/commands/[id] — single device_commands detail.
 * Permission: system.kiosks.view.
 *
 * Returns the sanitized command row, bound kiosk/system-device context, correlated
 * ack events (device_events), the retry lineage (attempt_count + derivable
 * idempotency keys), linked rental, related rental_exceptions, and audit events
 * from both system_audit_events (resource device_command:<id>) and audit_logs.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  const detail = await getCommandDetail(g.db, id);
  if (!detail) return NextResponse.json({ error: "Command not found" }, { status: 404 });
  return NextResponse.json({ command: detail });
}
