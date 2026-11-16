import { NextResponse } from "next/server";
import { z } from "zod";
import { needCtx, run } from "@/lib/helpdesk/http";
import { createTicket } from "@/lib/helpdesk/service";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { TICKET_CATEGORIES, looksLikeCardNumber } from "@/lib/validation";

export const dynamic = "force-dynamic";

const schema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  description: z.string().trim().min(10).max(4000),
  rental_ref: z.string().trim().max(60).optional().or(z.literal("")),
});

/** The signed-in customer's support tickets (same helpdesk as the website; owner = profile email). */
export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const all = await ctx.repo.listTickets({ q: c.email, limit: 100 });
  const mine = all.filter((t) => t.requesterType === "customer" && t.email.toLowerCase() === c.email.toLowerCase());
  return NextResponse.json({
    tickets: mine.map((t) => ({ number: t.number, category: t.category, subject: t.subject, state: t.state, rental_ref: t.rentalRef, created_at: t.createdAt, updated_at: (t as { updatedAt?: string }).updatedAt ?? t.createdAt })),
    categories: TICKET_CATEGORIES,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-ticket:${c.user.id}`, 5, 10 * 60_000).ok) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a topic and describe the problem (at least 10 characters)." }, { status: 422 });
  const d = parsed.data;
  if (looksLikeCardNumber(d.description) || (d.rental_ref && looksLikeCardNumber(d.rental_ref))) {
    return NextResponse.json({ error: "Please remove anything that looks like a payment card number. We never need it." }, { status: 422 });
  }
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  return run("mobile-ticket-create", async () => {
    const { ticket } = await createTicket(ctx, {
      requesterType: "customer", name: c.name, email: c.email, category: d.category, description: d.description,
      rentalRef: d.rental_ref ? d.rental_ref.toUpperCase() : null,
    });
    return { ok: true, number: ticket.number };
  });
}
