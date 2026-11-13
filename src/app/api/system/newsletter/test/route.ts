import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { sendOperatorTestDoi } from "@/lib/newsletter/service";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/**
 * POST /api/system/newsletter/test — send a real DOI email to an allowlisted
 * test address (*@zapnivo.com or NEWSLETTER_TEST_ADDRESSES). Exercises the full
 * production pipeline: pending subscriber row (source='operator_test') → outbox
 * → provider. Perm: system.users.manage (same as the resend route — both are
 * subscriber-lifecycle email actions). Non-allowlisted addresses get 403 BEFORE
 * any row is written.
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.users.manage", { limit: 10 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid email" }, { status: 400 });

  const res = await sendOperatorTestDoi(g.db, parsed.data.email);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "newsletter.test_sent",
    resource: `newsletter_subscriber:${res.subscriberId}`,
    detail: { action: res.action, queued: res.queued, sent: res.sent, reason: res.reason },
  });
  return NextResponse.json({
    ok: true,
    subscriberId: res.subscriberId,
    action: res.action,
    queued: res.queued,
    sent: res.sent,
    reason: res.reason,
  });
}
