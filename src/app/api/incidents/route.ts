import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { incidentCategory, INCIDENT_KINDS } from "@/lib/customer";
import { clientIp, fail, needCtx, sameOrigin } from "@/lib/helpdesk/http";
import { createTicket } from "@/lib/helpdesk/service";
import { HelpdeskError } from "@/lib/helpdesk/types";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { looksLikeCardNumber } from "@/lib/validation";

const schema = z.object({
  rental: z.string().trim().toUpperCase().regex(/^ZR-[A-Z0-9]{8}$/),
  kind: z.enum(INCIDENT_KINDS),
  description: z.string().trim().min(10).max(2000),
});

/** Signed-in customer reports a lost/damaged/stolen charger for a rental they own. Ticket goes through the helpdesk service. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in to report a problem.");
  if (!rateLimit(`incident:${user.id}:${clientIp(req)}`, 5, 10 * 60_000).ok) return fail(429, "Too many requests. Please try again later.");

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Enter a rental reference like ZR-1A2B3C4D and at least 10 characters of detail.");
  const d = parsed.data;
  if (looksLikeCardNumber(d.description)) return fail(422, "Please remove anything that looks like a payment card number. We never need it.");

  const db = serviceClient();
  if (!db) return fail(503, "Incident reporting isn't available yet.", { code: "backend_unconfigured" });
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;

  // Ownership: renter_profile is the user, or a payment on the rental carries the user's receipt email.
  const { data: rental } = await db
    .from("rentals")
    .select("id,renter_profile,kiosks!rentals_kiosk_id_fkey(station_id),payments(receipt_email)")
    .eq("reference", d.rental)
    .maybeSingle();
  const r = rental as unknown as { id: string; renter_profile: string | null; kiosks: { station_id: string } | null; payments: { receipt_email: string | null }[] } | null;
  const email = user.email.toLowerCase();
  const owns = !!r && (r.renter_profile === user.id || (!!email && r.payments.some((p) => p.receipt_email?.toLowerCase() === email)));
  if (!r || !owns) return fail(404, "We couldn't find that rental on your account.");

  try {
    const { ticket } = await createTicket(ctx, {
      requesterType: "customer", name: user.email.split("@")[0] || "Customer", email: user.email,
      category: incidentCategory(d.kind), description: `[${d.kind.toUpperCase()}] ${d.description}`,
      rentalRef: d.rental, stationLabel: r.kiosks?.station_id ?? null,
    });
    const { error } = await db.from("incident_reports").insert({
      rental_id: r.id, ticket_id: ticket.id, kind: d.kind, description: d.description, created_by: /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null,
    });
    if (error) console.error(JSON.stringify({ level: "error", scope: "incident-insert", msg: error.message }));
    return NextResponse.json({ ok: true, ticketNumber: ticket.number });
  } catch (e) {
    if (e instanceof HelpdeskError) return fail(400, e.message, { code: e.code });
    console.error(JSON.stringify({ level: "error", scope: "incident", msg: e instanceof Error ? e.message : "unknown" }));
    return fail(500, "Something went wrong. Please try again.");
  }
}
