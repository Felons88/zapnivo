import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import { resendConfirmation } from "@/lib/newsletter/service";

const schema = z.object({ id: z.string().uuid() });

/**
 * POST /api/system/newsletter/resend — rotate tokens + resend the DOI email for a
 * pending subscriber. Perm: system.users.manage (subscriber lifecycle action).
 */
export async function POST(req: Request) {
  const g = await systemApiGuard("system.users.manage", { limit: 20 });
  if (!g.ok) return g.res;
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const res = await resendConfirmation(g.db, parsed.data.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "newsletter.confirm_resent",
    resource: `newsletter_subscriber:${parsed.data.id}`,
    detail: {},
  });
  return NextResponse.json({ ok: true });
}
