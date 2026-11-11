import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../../_shared";
import { retryOutboxEmail } from "@/lib/system/jobs";

const retrySchema = z.object({ justification: z.string().max(2000).optional() });

/**
 * POST /api/system/jobs/email-outbox/[id]/retry — requeue a failed
 * email_outbox row (failed → queued) so the next mailer flush sends it.
 * Perm: system.webhooks.retry. Audited; breakglass callers need an approved
 * change request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.webhooks.retry", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await readJson(req);
  const parsed = retrySchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const result = await retryOutboxEmail(g.db, { id: g.user.id, role: g.role }, id, parsed.data.justification);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status === 202 ? 202 : result.status });
  }
  return NextResponse.json({ ok: true, emailId: result.emailId, changeRequestId: result.changeRequestId });
}
