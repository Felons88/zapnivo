import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAccess } from "@/lib/helpdesk/access";
import { clientIp, fail, limit, needCtx, run, sameOrigin } from "@/lib/helpdesk/http";
import { requesterMessage, requesterResolve, requestHuman } from "@/lib/helpdesk/service";
import { looksLikeCardNumber } from "@/lib/validation";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), token: z.string().max(600), body: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("human"), token: z.string().max(600) }),
  z.object({ action: z.literal("resolve"), token: z.string().max(600) }),
]);

/** Customer actions on their own thread. Authenticated by a signed, expiring, ticket-bound token. */
export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const { number } = await params;
  const rl = limit(`thread:${clientIp(req)}`, 30, 10 * 60_000);
  const rl2 = limit(`thread-t:${number}`, 40, 10 * 60_000);
  if (!rl.ok || !rl2.ok) return NextResponse.json({ error: "You're sending messages quickly. Please wait a moment." }, { status: 429 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Invalid request.");
  const email = verifyAccess(parsed.data.token, number);
  if (!email) return fail(403, "This link has expired. Use Track a ticket on the support page to open it again.");
  if (parsed.data.action === "reply" && looksLikeCardNumber(parsed.data.body)) return fail(422, "Please remove anything that looks like a payment card number. We never need it.");

  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const actor = { kind: "customer" as const, email };
  return run("thread", async () => {
    if (parsed.data.action === "reply") await requesterMessage(ctx, actor, number, parsed.data.body);
    else if (parsed.data.action === "human") await requestHuman(ctx, actor, number);
    else await requesterResolve(ctx, actor, number);
    return { ok: true };
  });
}
