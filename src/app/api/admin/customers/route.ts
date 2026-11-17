import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { createTicket, defaultCtx, internalNote } from "@/lib/helpdesk/service";
import { HelpdeskError, type Actor } from "@/lib/helpdesk/types";
import { serviceClient } from "@/lib/supabase";
import { TICKET_CATEGORIES } from "@/lib/validation";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Redirect back to the customer's 360 page with feedback in the querystring. */
function back(req: Request, email: string, result: string, detail: string) {
  const url = new URL(`/admin/customers/${encodeURIComponent(email)}`, req.url);
  url.searchParams.set("result", result);
  url.searchParams.set("detail", detail.slice(0, 200));
  return NextResponse.redirect(url, 303);
}

/** Staff actions on a customer record: internal notes + agent-created tickets. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = Object.fromEntries(await req.formData()) as Record<string, string>;
  const email = (form.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Valid customer email required" }, { status: 422 });

  if (form.action === "add_note") {
    const body = (form.body ?? "").trim();
    if (body.length < 2 || body.length > 4000) return back(req, email, "error", "Note must be 2–4000 characters.");
    const { error } = await db.from("customer_notes").insert({ customer_email: email, body, author: /^[0-9a-f-]{36}$/i.test(user!.id) ? user!.id : null });
    if (error) return back(req, email, "error", "Couldn't save the note.");
    await auditLog(user!.id, "customer_note_added", "customer", email);
    return back(req, email, "ok", "Note saved.");
  }

  if (form.action === "create_ticket") {
    const p = z.object({
      name: z.string().trim().min(1).max(120),
      phone: z.string().trim().max(40).optional(),
      category: z.enum(TICKET_CATEGORIES),
      description: z.string().trim().min(10).max(4000),
      rentalRef: z.string().trim().max(20).optional(),
    }).safeParse(form);
    if (!p.success) return back(req, email, "error", p.error.issues[0]?.message ?? "Check the ticket fields.");
    const ctx = await defaultCtx();
    if (!ctx) return back(req, email, "error", "Helpdesk backend isn't configured.");
    try {
      const { ticket } = await createTicket(ctx, {
        requesterType: "customer",
        name: p.data.name,
        email,
        phone: p.data.phone || null,
        category: p.data.category,
        description: p.data.description,
        rentalRef: p.data.rentalRef || null,
      });
      const actor: Actor = { kind: "staff", id: user!.id, name: user!.email, role: user!.role as "admin" | "staff" };
      await internalNote(ctx, actor, ticket.number, `Ticket opened by ${user!.email} from the customer 360 (phone/walk-up contact).`);
      await auditLog(user!.id, "customer_ticket_created", "ticket", ticket.number, { customer: email });
      return back(req, email, "ok", `Ticket ${ticket.number} created — the customer was emailed a confirmation.`);
    } catch (e) {
      const msg = e instanceof HelpdeskError ? e.message : "Couldn't create the ticket.";
      return back(req, email, "error", msg);
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
