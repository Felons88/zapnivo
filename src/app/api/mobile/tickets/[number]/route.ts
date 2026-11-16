import { NextResponse } from "next/server";
import { z } from "zod";
import { needCtx, run } from "@/lib/helpdesk/http";
import { getRequesterThread, requestHuman, requesterMessage, requesterResolve } from "@/lib/helpdesk/service";
import type { Actor } from "@/lib/helpdesk/types";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { looksLikeCardNumber } from "@/lib/validation";

export const dynamic = "force-dynamic";

const NUMBER = /^[A-Za-z0-9-]{3,24}$/;
const schema = z.object({ action: z.enum(["reply", "human", "resolve"]), body: z.string().trim().max(2000).optional() });

export async function GET(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!NUMBER.test(number)) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const actor: Actor = { kind: "customer", email: c.email };
  return run("mobile-ticket-thread", () => getRequesterThread(ctx, actor, number));
}

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!NUMBER.test(number)) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-ticket-msg:${c.user.id}`, 30, 10 * 60_000).ok) return NextResponse.json({ error: "Too many messages. Try again later." }, { status: 429 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const { action, body } = parsed.data;
  if (action === "reply" && (!body || looksLikeCardNumber(body))) {
    return NextResponse.json({ error: body ? "Please remove anything that looks like a payment card number." : "Write a message first." }, { status: 422 });
  }
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const actor: Actor = { kind: "customer", email: c.email };
  return run("mobile-ticket-action", async () => {
    if (action === "reply") await requesterMessage(ctx, actor, number, body!);
    else if (action === "human") await requestHuman(ctx, actor, number);
    else await requesterResolve(ctx, actor, number);
    return getRequesterThread(ctx, actor, number);
  });
}
