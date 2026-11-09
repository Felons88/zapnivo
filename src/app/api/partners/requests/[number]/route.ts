import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, limit, needCtx, partnerActor, run, sameOrigin } from "@/lib/helpdesk/http";
import { requesterMessage } from "@/lib/helpdesk/service";

const schema = z.object({ body: z.string().trim().min(1).max(2000) });

/** A partner replies on one of their organization's tickets. Ownership is enforced by org id in the service. */
export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const actor = await partnerActor();
  if (!actor) return fail(403, "Partner sign-in required.");
  if (!limit(`partner-msg:${actor.id}`, 30, 10 * 60_000).ok) return fail(429, "Too many messages. Please wait a moment.");
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Message must be 1–2000 characters.");
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const { number } = await params;
  return run("partner-msg", async () => { await requesterMessage(ctx, actor, number, parsed.data.body); return { ok: true }; });
}
