import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, limit, needCtx, partnerActor, run, sameOrigin } from "@/lib/helpdesk/http";
import { createTicket } from "@/lib/helpdesk/service";
import { PARTNER_CATEGORIES } from "@/lib/helpdesk/types";
import { looksLikeCardNumber } from "@/lib/validation";

const schema = z.object({
  category: z.enum(PARTNER_CATEGORIES),
  description: z.string().trim().min(10).max(3000),
  venueLabel: z.string().trim().max(160).optional(),
});

/** Authenticated venue partners open requests with Zapnivo partner relations. The org comes from the session, never the request. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const actor = await partnerActor();
  if (!actor) return fail(403, "Partner sign-in required.");
  if (!limit(`partner-req:${actor.id}`, 10, 10 * 60_000).ok) return fail(429, "Too many requests. Please wait a few minutes.");

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Please check your request.", { fields: parsed.error.flatten().fieldErrors });
  if (looksLikeCardNumber(parsed.data.description)) return fail(422, "Please remove anything that looks like a payment card number.");
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;

  return run("partner-ticket", async () => {
    const { ticket } = await createTicket(ctx, { requesterType: "partner", name: actor.name, email: actor.email, category: parsed.data.category, description: parsed.data.description, orgId: actor.orgId, venueLabel: parsed.data.venueLabel ?? null });
    return { ok: true, ticketNumber: ticket.number };
  });
}
