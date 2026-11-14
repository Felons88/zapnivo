import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { replayWebhookEvent, WEBHOOK_SOURCES, type WebhookSourceId } from "@/lib/system/webhooks";

const replaySchema = z.object({ justification: z.string().max(2000).optional() });

/**
 * POST /api/system/webhooks/[id]/replay — replay a failed/dead inbound_jobs row
 * by inserting a NEW queued attempt (the original row is never mutated; the
 * worker re-processes through the real pipeline with dedupe). Perm:
 * system.webhooks.retry, rate-limited 20/min. stripe_events → 403
 * forbidden_financial; all other sources → 409 replay_unsupported;
 * non-email_message kinds → 409 kind_not_replayable; >5 replays → 409
 * replay_limit. Breakglass/high-risk callers get a pending change request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.webhooks.retry", { limit: 20 });
  if (!g.ok) return g.res;
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  const sep = decoded.indexOf(":");
  const source = sep > 0 ? decoded.slice(0, sep) : "";
  const rowId = sep > 0 ? decoded.slice(sep + 1) : "";
  if (!rowId || rowId.length > 100 || !(WEBHOOK_SOURCES as readonly string[]).includes(source)) {
    return NextResponse.json({ error: "Invalid event ref — expected source:rowId" }, { status: 400 });
  }

  const body = await readJson(req);
  const parsed = replaySchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const result = await replayWebhookEvent(g.db, { id: g.user.id, role: g.role }, source as WebhookSourceId, rowId, parsed.data.justification);
  if (!result.ok) {
    const status = result.status === 202 ? 202 : result.status;
    return NextResponse.json({ error: result.error, reason: "reason" in result ? result.reason : undefined }, { status });
  }
  return NextResponse.json({ ok: true, status: result.status, jobId: result.jobId, replayOf: result.replayOf, changeRequestId: result.changeRequestId });
}
