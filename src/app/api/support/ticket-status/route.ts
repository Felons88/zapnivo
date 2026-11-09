import { NextResponse } from "next/server";
import { signAccess } from "@/lib/helpdesk/access";
import { clientIp, fail, needCtx, sameOrigin } from "@/lib/helpdesk/http";
import { getRequesterThread } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";
import { rateLimit } from "@/lib/rate-limit";
import { ticketStatusSchema } from "@/lib/validation";

const NOT_FOUND = { found: false, message: "We couldn't find a ticket with that number and email." };

/** Ticket lookup: ticket number AND the email it was created with. Same answer for wrong number / wrong email. Returns a link to the full conversation. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const parsed = ticketStatusSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, parsed.error.issues[0]?.message ?? "Check your details.");
  const { ticketNumber, email } = parsed.data;

  const a = rateLimit(`tstatus-ip:${clientIp(req)}`, 15, 15 * 60_000);
  const b = rateLimit(`tstatus-t:${ticketNumber}`, 6, 15 * 60_000);
  if (!a.ok || !b.ok) return NextResponse.json({ error: "Too many attempts. Please wait a few minutes." }, { status: 429, headers: { "Retry-After": String(Math.max(a.retryAfter, b.retryAfter)) } });

  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await getRequesterThread(ctx, { kind: "customer", email }, ticketNumber);
    const token = signAccess(ticketNumber, email);
    return NextResponse.json({ found: true, ticket: { number: thread.number, category: thread.category, state: thread.state, createdAt: thread.createdAt, withPerson: thread.withPerson, threadUrl: `/support/ticket/${thread.number}${token ? `?t=${token}` : ""}` } });
  } catch (e) {
    if (e instanceof HelpdeskError && (e.code === "forbidden" || e.code === "not_found")) return NextResponse.json(NOT_FOUND);
    return fail(500, "Tracking is unavailable right now. Please try again.");
  }
}
