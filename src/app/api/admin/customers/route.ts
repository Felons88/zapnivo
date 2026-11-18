import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { searchCustomers } from "@/lib/crm";
import { sendToCustomer } from "@/lib/email-triggers";
import { createTicket, defaultCtx, internalNote, requestRefund } from "@/lib/helpdesk/service";
import { HelpdeskError, REFUND_REASONS, type Actor } from "@/lib/helpdesk/types";
import { fmt } from "@/lib/pricing";
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

const actor = (u: { id: string; email: string; role: string }): Actor => ({ kind: "staff", id: u.id, name: u.email, role: u.role as "admin" | "staff" });

/** Live customer search — powers the type-ahead on /admin/customers. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const results = await searchCustomers(db, q);
  return NextResponse.json({ results });
}

/** Staff actions on a customer record: notes, agent-created tickets, refunds, credits. */
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
      const a = actor(user!);
      await internalNote(ctx, a, ticket.number, `Ticket opened by ${user!.email} from the customer 360 (phone/walk-up contact).`);
      await auditLog(user!.id, "customer_ticket_created", "ticket", ticket.number, { customer: email });
      return back(req, email, "ok", `Ticket ${ticket.number} created — the customer was emailed a confirmation.`);
    } catch (e) {
      const msg = e instanceof HelpdeskError ? e.message : "Couldn't create the ticket.";
      return back(req, email, "error", msg);
    }
  }

  if (form.action === "request_refund") {
    const p = z.object({
      rentalRef: z.string().trim().min(4).max(20),
      reason: z.enum(REFUND_REASONS),
      amountDollars: z.coerce.number().min(0.01).max(1_000),
      name: z.string().trim().min(1).max(120).optional(),
    }).safeParse(form);
    if (!p.success) return back(req, email, "error", "Check the refund fields — a rental, reason and amount are required.");
    const amountCents = Math.round(p.data.amountDollars * 100);
    const ctx = await defaultCtx();
    if (!ctx) return back(req, email, "error", "Helpdesk backend isn't configured.");
    const a = actor(user!);
    try {
      // Refunds live on tickets — open one so the policy workflow, audit trail and
      // customer notifications all work exactly as they do for inbound requests.
      const { ticket } = await createTicket(ctx, {
        requesterType: "customer",
        name: p.data.name ?? email.split("@")[0],
        email,
        category: "Refund request",
        description: `Refund requested by support for rental ${p.data.rentalRef} (${fmt(amountCents)}, ${p.data.reason.replace(/_/g, " ")}).`,
        rentalRef: p.data.rentalRef,
      });
      await internalNote(ctx, a, ticket.number, `Refund request entered by ${user!.email} from the customer 360.`);
      const r = await requestRefund(ctx, a, { number: ticket.number, rentalRef: p.data.rentalRef, reason: p.data.reason, amountCents });
      await auditLog(user!.id, "customer_refund_requested", "refund", r.id, { customer: email, rental: p.data.rentalRef, amount_cents: r.amountCents });
      return back(req, email, "ok", `Refund of ${fmt(r.amountCents)} requested on ${r.rentalRef} via ${ticket.number}${r.requiresAdmin ? " — needs a second admin to approve." : " — ready to issue."}`);
    } catch (e) {
      const msg = e instanceof HelpdeskError ? e.message : "Couldn't create the refund request.";
      return back(req, email, "error", msg);
    }
  }

  if (form.action === "grant_credit") {
    // Entitlement credits only exist on accounts — guests have no profile to grant to.
    const p = z.object({
      unit: z.enum(["cent", "minute", "rental"]),
      amount: z.coerce.number().positive().max(10_000),
      note: z.string().trim().max(200).optional(),
    }).safeParse(form);
    if (!p.success) return back(req, email, "error", "Check the credit fields.");
    // Staff enter dollars for money credits — storage stays in the ledger's unit.
    const units = p.data.unit === "cent" ? Math.round(p.data.amount * 100) : Math.round(p.data.amount);
    if (!Number.isInteger(units) || units < 1) return back(req, email, "error", "Enter a valid amount.");
    const { data: prof } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    const pid = (prof as { id: string } | null)?.id;
    if (!pid) return back(req, email, "error", "This customer has no account — credits can only be granted to registered profiles.");
    const { data: grant, error } = await db.from("entitlement_grants").insert({
      profile_id: pid, kind: "adjustment", unit: p.data.unit, granted: units, remaining: units,
      source_type: "manual", source_id: user!.id,
    }).select("id").single();
    if (error) return back(req, email, "error", "Couldn't grant the credit.");
    await db.from("entitlement_events").insert({ grant_id: (grant as { id: string } | null)?.id ?? null, profile_id: pid, event: "grant", delta: units, balance_after: units, ref_type: "manual", ref_id: user!.id, actor: `staff:${user!.id}`, note: p.data.note ?? "Granted from customer 360" }).then(() => undefined, () => undefined);
    await auditLog(user!.id, "customer_credit_granted", "customer", email, { unit: p.data.unit, amount: units, note: p.data.note ?? null });
    const label = p.data.unit === "cent" ? fmt(units) : `${units} ${p.data.unit === "minute" ? "minutes" : "free rental"}`;
    try {
      await sendToCustomer(email, "A credit was added to your Zapnivo account", `We've added ${label} to your Zapnivo account as a service credit${p.data.note ? ` (${p.data.note})` : ""}. It applies automatically on your next rental.`, null, null, { sender: "support" });
    } catch { /* notification is best-effort; the credit itself is recorded */ }
    return back(req, email, "ok", `Granted ${label} of credit — customer notified by email.`);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
