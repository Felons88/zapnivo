import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "../auth";
import { likeEscape } from "../customer";
import { defaultCtx, createTicket, requesterMessage, requestHuman, type Ctx } from "../helpdesk/service";
import { HelpdeskError, PARTNER_CATEGORIES, type Actor } from "../helpdesk/types";
import { newTraceId, recordLog, recordSpan } from "../observability";
import { fmt } from "../pricing";
import type { RentalRow } from "../rental-lookup";
import { normalizePhone } from "../sms";
import { TICKET_CATEGORIES, looksLikeCardNumber } from "../validation";
import type { ToolDef } from "./openrouter";

/**
 * Authenticated account tools for the support assistant. Every function takes the service-role
 * client AND the verified SessionUser, and scopes every query to that actor — the model can never
 * supply a user id, email or phone. Results are JSON strings for the tool loop; they never contain
 * card data, Stripe ids, or other customers' information.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
const ACTIVE_STATES = ["authorized", "dispense_pending", "active", "unreturned"];
const HISTORY_STATES = ["returned", "cancelled"];
const MAX_BODY = 2000;

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ok = (v: unknown) => JSON.stringify(v);
const fail = (error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error, ...extra });

const logTool = (name: string, outcome: "ok" | "error" = "ok", durationMs?: number, traceId?: string) =>
  recordLog("info", "ai_account_tool", { service: "ai-assistant", traceId, attrs: { tool: name, outcome, durationMs } });

type Profile = { phone: string | null; full_name: string | null };

async function profileOf(db: SupabaseClient, actor: SessionUser): Promise<Profile> {
  if (!UUID_RE.test(actor.id)) return { phone: null, full_name: null };
  const { data } = await db.from("profiles").select("phone,full_name").eq("id", actor.id).maybeSingle();
  return (data as Profile | null) ?? { phone: null, full_name: null };
}

/** Phone variants a customer may have typed at kiosk checkout (raw profile value + E.164). */
function phoneVariants(profilePhone: string | null): string[] {
  const out = new Set<string>();
  if (profilePhone) { out.add(profilePhone); const n = normalizePhone(profilePhone); if (n) out.add(n); }
  return [...out];
}

const RENTAL_SELECT =
  "id,reference,state,customer_id,renter_profile,started_at,dispensed_at,returned_at,created_at,non_return_deadline," +
  "kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city))," +
  "payments(state,amount_authorized_cents,amount_captured_cents,amount_refunded_cents,receipt_email,customer_phone)";

type PaymentRow = { state: string; amount_authorized_cents: number | null; amount_captured_cents: number | null; amount_refunded_cents: number | null; receipt_email: string | null; customer_phone: string | null };
type AccountRentalRow = Omit<RentalRow, "payments"> & { id?: string; customer_id?: string | null; renter_profile?: string | null; created_at?: string; payments: PaymentRow[] };

const stationOf = (r: AccountRentalRow) => (r.kiosks?.venues ? `${r.kiosks.venues.name}, ${r.kiosks.venues.city}` : r.kiosks?.station_id ?? "Zapnivo station");
const cents = (rows: PaymentRow[], key: "amount_authorized_cents" | "amount_captured_cents" | "amount_refunded_cents") =>
  rows.reduce((s, p) => s + (p[key] ?? 0), 0);

/**
 * Every rental id this actor can prove ownership of: account link (customer_id / renter_profile),
 * receipt email on a payment, or the verified profile phone on a kiosk payment. All values come
 * from the session, never from tool arguments.
 */
async function ownedRentalIds(db: SupabaseClient, actor: SessionUser, profile: Profile): Promise<string[]> {
  const ids = new Set<string>();
  if (UUID_RE.test(actor.id)) {
    const { data } = await db.from("rentals").select("id").or(`customer_id.eq.${actor.id},renter_profile.eq.${actor.id}`).limit(500);
    for (const r of (data ?? []) as { id: string }[]) ids.add(r.id);
  }
  const email = actor.email.trim().toLowerCase();
  if (email) {
    const { data } = await db.from("payments").select("rental_id").ilike("receipt_email", likeEscape(email)).limit(300);
    for (const p of (data ?? []) as { rental_id: string }[]) ids.add(p.rental_id);
  }
  const phones = phoneVariants(profile.phone);
  if (phones.length) {
    const { data } = await db.from("payments").select("rental_id").in("customer_phone", phones).limit(300);
    for (const p of (data ?? []) as { rental_id: string }[]) ids.add(p.rental_id);
  }
  return [...ids];
}

/** Direct row-level ownership check for a single rental already fetched by reference. */
function ownsRental(r: AccountRentalRow, actor: SessionUser, profile: Profile): boolean {
  if (UUID_RE.test(actor.id) && (r.customer_id === actor.id || r.renter_profile === actor.id)) return true;
  const email = actor.email.trim().toLowerCase();
  const phones = phoneVariants(profile.phone);
  return r.payments.some((p) =>
    (email && (p.receipt_email ?? "").toLowerCase() === email) ||
    (phones.length > 0 && !!p.customer_phone && phones.includes(p.customer_phone)));
}

const paymentSummary = (p: PaymentRow) => ({
  state: p.state,
  authorizedCents: p.amount_authorized_cents ?? null,
  capturedCents: p.amount_captured_cents ?? null,
  refundedCents: p.amount_refunded_cents ?? null,
});

/* ── Rentals ─────────────────────────────────────────────────────────────── */

async function getMyActiveRentals(db: SupabaseClient, actor: SessionUser): Promise<string> {
  const profile = await profileOf(db, actor);
  const ids = await ownedRentalIds(db, actor, profile);
  if (!ids.length) return ok({ rentals: [] });
  const { data, error } = await db.from("rentals").select(RENTAL_SELECT).in("id", ids).in("state", ACTIVE_STATES)
    .order("created_at", { ascending: false }).limit(20);
  if (error) return fail("unavailable");
  const rentals = ((data ?? []) as unknown as AccountRentalRow[]).map((r) => ({
    reference: r.reference,
    state: r.state,
    station: stationOf(r),
    startedAt: r.dispensed_at ?? r.started_at,
    returnedAt: r.returned_at,
    authorizedCents: cents(r.payments, "amount_authorized_cents"),
    capturedCents: cents(r.payments, "amount_captured_cents"),
    refundedCents: cents(r.payments, "amount_refunded_cents"),
    amountSoFar: fmt(cents(r.payments, "amount_captured_cents")),
    paymentStates: r.payments.map((p) => p.state),
  }));
  return ok({ rentals });
}

async function getMyRentalHistory(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const profile = await profileOf(db, actor);
  const ids = await ownedRentalIds(db, actor, profile);
  if (!ids.length) return ok({ rentals: [] });
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  const { data, error } = await db.from("rentals").select(RENTAL_SELECT).in("id", ids).in("state", HISTORY_STATES)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return fail("unavailable");
  const rentals = ((data ?? []) as unknown as AccountRentalRow[]).map((r) => ({
    reference: r.reference,
    state: r.state,
    station: stationOf(r),
    startedAt: r.dispensed_at ?? r.started_at,
    returnedAt: r.returned_at,
    capturedCents: cents(r.payments, "amount_captured_cents"),
    refundedCents: cents(r.payments, "amount_refunded_cents"),
    charge: fmt(cents(r.payments, "amount_captured_cents")),
  }));
  return ok({ rentals });
}

async function findOwnedRental(db: SupabaseClient, actor: SessionUser, profile: Profile, reference: string): Promise<AccountRentalRow | null | "error"> {
  const ref = reference.trim().toUpperCase();
  if (!ref) return null;
  const { data, error } = await db.from("rentals").select(RENTAL_SELECT).eq("reference", ref).maybeSingle();
  if (error) return "error";
  const row = (data as unknown as AccountRentalRow | null) ?? null;
  if (!row || !ownsRental(row, actor, profile)) return null; // never reveal that someone else's rental exists
  return row;
}

async function getMyRentalDetails(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const profile = await profileOf(db, actor);
  const r = await findOwnedRental(db, actor, profile, str(args.reference, 40));
  if (r === "error") return fail("unavailable");
  if (!r) return fail("not_found", { note: "No rental with that reference belongs to this account." });
  return ok({
    reference: r.reference,
    state: r.state,
    station: stationOf(r),
    startedAt: r.dispensed_at ?? r.started_at,
    returnedAt: r.returned_at,
    nonReturnDeadline: r.non_return_deadline,
    payments: r.payments.map(paymentSummary),
    totals: {
      authorizedCents: cents(r.payments, "amount_authorized_cents"),
      capturedCents: cents(r.payments, "amount_captured_cents"),
      refundedCents: cents(r.payments, "amount_refunded_cents"),
    },
  });
}

async function getMyPaymentStatus(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const profile = await profileOf(db, actor);
  const r = await findOwnedRental(db, actor, profile, str(args.reference, 40));
  if (r === "error") return fail("unavailable");
  if (!r) return fail("not_found", { note: "No rental with that reference belongs to this account." });
  return ok({
    reference: r.reference,
    rentalState: r.state,
    payments: r.payments.map(paymentSummary),
    totals: {
      authorizedCents: cents(r.payments, "amount_authorized_cents"),
      capturedCents: cents(r.payments, "amount_captured_cents"),
      refundedCents: cents(r.payments, "amount_refunded_cents"),
    },
    note: "Authorization is a temporary hold, not a charge. Captured amounts are final charges; refunded amounts have been returned.",
  });
}

/* ── Support tickets ─────────────────────────────────────────────────────── */

type TicketRow = { ticket_number: string; subject: string | null; category: string; state: string; priority: string; requester_type: string; organization_id: string | null; created_at: string; updated_at: string };

/** PostgREST `or` filter for tickets this actor owns: email, verified phone, or partner org. */
function ticketOwnerFilter(actor: SessionUser, profile: Profile): string | null {
  const parts: string[] = [];
  const email = actor.email.trim();
  if (email) parts.push(`email.eq.${email}`);
  const phone = profile.phone?.trim();
  if (phone) parts.push(`phone.eq.${phone}`);
  if (actor.role === "partner" && actor.organizationId && UUID_RE.test(actor.organizationId)) {
    parts.push(`and(requester_type.eq.partner,organization_id.eq.${actor.organizationId})`);
  }
  return parts.length ? parts.join(",") : null;
}

const ticketSummary = (t: TicketRow) => ({
  number: t.ticket_number, subject: t.subject, category: t.category, state: t.state,
  priority: t.priority, requesterType: t.requester_type, createdAt: t.created_at, updatedAt: t.updated_at,
});

async function getMySupportTickets(db: SupabaseClient, actor: SessionUser): Promise<string> {
  const profile = await profileOf(db, actor);
  const filter = ticketOwnerFilter(actor, profile);
  if (!filter) return ok({ tickets: [] });
  const { data, error } = await db.from("support_tickets")
    .select("ticket_number,subject,category,state,priority,requester_type,organization_id,created_at,updated_at")
    .or(filter)
    .order("updated_at", { ascending: false }).limit(25);
  if (error) return fail("unavailable");
  return ok({ tickets: ((data ?? []) as unknown as TicketRow[]).map(ticketSummary) });
}

/** Ownership check for a ticket fetched by number — mirrors the service's assertOwner rules. */
function ownsTicket(t: { email: string; phone: string | null; requesterType: string; orgId: string | null }, actor: SessionUser, profile: Profile): boolean {
  if (t.requesterType === "customer" && t.email.toLowerCase() === actor.email.trim().toLowerCase()) return true;
  const phone = profile.phone?.trim();
  if (phone && t.phone === phone) return true;
  if (t.requesterType === "partner" && t.orgId && actor.role === "partner" && t.orgId === actor.organizationId) return true;
  return false;
}

/** Actor the helpdesk service expects for this signed-in user (customer or partner). */
function helpdeskActor(actor: SessionUser, profile: Profile): Actor {
  if (actor.role === "partner" && actor.organizationId) {
    return { kind: "partner", id: actor.id, name: profile.full_name ?? actor.email.split("@")[0], email: actor.email, orgId: actor.organizationId };
  }
  return { kind: "customer", email: actor.email };
}

const ctxOrError = async (): Promise<Ctx | null> => defaultCtx();

const ticketError = (e: unknown) => {
  if (e instanceof HelpdeskError) {
    if (e.code === "not_found" || e.code === "forbidden") return fail("not_found", { note: "No ticket with that number belongs to this account." });
    return fail(e.code === "unavailable" ? "unavailable" : "invalid", { note: e.message });
  }
  return fail("unavailable");
};

const cleanBody = (v: unknown): string | null => {
  const text = str(v, 8000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_BODY || looksLikeCardNumber(text)) return null;
  return text;
};

async function getMySupportTicketDetails(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const ctx = await ctxOrError();
  if (!ctx) return fail("unavailable");
  const number = str(args.number, 20).toUpperCase();
  if (!/^Z-\d{3,9}$/.test(number)) return fail("invalid", { note: "Ticket numbers look like Z-1234." });
  const t = await ctx.repo.getTicketByNumber(number);
  if (!t) return fail("not_found", { note: "No ticket with that number belongs to this account." });
  const profile = await profileOf(db, actor);
  if (!ownsTicket(t, actor, profile)) return fail("not_found", { note: "No ticket with that number belongs to this account." });
  const messages = (await ctx.repo.listMessages(t.id)).slice(-20).map((m) => ({
    from: m.authorName, type: m.authorType, body: m.body, createdAt: m.createdAt,
  }));
  return ok({ number: t.number, subject: t.subject, category: t.category, state: t.state, priority: t.priority, createdAt: t.createdAt, updatedAt: t.updatedAt, messages });
}

const CUSTOMER_CATEGORIES = new Set<string>(TICKET_CATEGORIES);
const PARTNER_CATEGORY_SET = new Set<string>(PARTNER_CATEGORIES);

async function createMySupportTicket(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const ctx = await ctxOrError();
  if (!ctx) return fail("unavailable");
  const body = cleanBody(args.body);
  if (!body) return fail("invalid", { note: `Describe the issue in 1–${MAX_BODY} characters. Never include card numbers.` });
  const isPartner = actor.role === "partner" && !!actor.organizationId;
  const allowed = isPartner ? PARTNER_CATEGORY_SET : CUSTOMER_CATEGORIES;
  const requested = str(args.category, 80);
  const category = allowed.has(requested) ? requested : "Other";
  const subject = str(args.subject, 120) || `${category}: ${body.replace(/\s+/g, " ").slice(0, 70)}`;
  const profile = await profileOf(db, actor);
  try {
    const { ticket } = await createTicket(ctx, {
      requesterType: isPartner ? "partner" : "customer",
      name: profile.full_name ?? actor.email.split("@")[0],
      email: actor.email,
      phone: profile.phone,
      category,
      description: body,
      subject,
      orgId: isPartner ? actor.organizationId : null,
    });
    return ok({ ok: true, ticket: ticket.number, state: ticket.state, note: `Ticket ${ticket.number} was created. The team replies by email; the customer can follow it on /support.` });
  } catch (e) { return ticketError(e); }
}

async function addMyTicketMessage(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const ctx = await ctxOrError();
  if (!ctx) return fail("unavailable");
  const body = cleanBody(args.body);
  if (!body) return fail("invalid", { note: `Message must be 1–${MAX_BODY} characters. Never include card numbers.` });
  const number = str(args.number, 20).toUpperCase();
  if (!/^Z-\d{3,9}$/.test(number)) return fail("invalid", { note: "Ticket numbers look like Z-1234." });
  const profile = await profileOf(db, actor);
  try {
    const t = await requesterMessage(ctx, helpdeskActor(actor, profile), number, body);
    return ok({ ok: true, ticket: t.number, state: t.state });
  } catch (e) { return ticketError(e); }
}

async function requestHumanSupport(db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  const ctx = await ctxOrError();
  if (!ctx) return fail("unavailable");
  const profile = await profileOf(db, actor);
  const ha = helpdeskActor(actor, profile);
  const reason = str(args.reason, MAX_BODY);
  try {
    // Prefer flagging an existing open ticket the actor owns.
    const filter = ticketOwnerFilter(actor, profile);
    if (filter) {
      const { data } = await db.from("support_tickets")
        .select("ticket_number")
        .or(filter)
        .in("state", ["open", "pending_customer", "pending_internal"])
        .order("updated_at", { ascending: false }).limit(1);
      const number = (data?.[0] as { ticket_number?: string } | undefined)?.ticket_number;
      if (number) {
        const t = await requestHuman(ctx, ha, number);
        return ok({ ok: true, escalated: t.number, note: `Ticket ${t.number} is now flagged for a human agent.` });
      }
    }
    const body = reason || "The customer asked to speak with a human agent via the AI assistant.";
    const { ticket } = await createTicket(ctx, {
      requesterType: ha.kind === "partner" ? "partner" : "customer",
      name: ha.kind === "partner" ? ha.name : actor.email.split("@")[0],
      email: actor.email,
      phone: profile.phone,
      category: "Other",
      description: body,
      subject: "Request for human support",
      orgId: ha.kind === "partner" ? ha.orgId : null,
    });
    const t = await requestHuman(ctx, ha, ticket.number);
    return ok({ ok: true, ticket: t.number, note: `Created ticket ${t.number} and flagged it for a human agent.` });
  } catch (e) { return ticketError(e); }
}

/* ── Partner self-service ────────────────────────────────────────────────── */

async function getMyPartnerInformation(db: SupabaseClient, actor: SessionUser): Promise<string> {
  if (actor.role !== "partner" || !actor.organizationId || !UUID_RE.test(actor.organizationId)) return fail("forbidden", { note: "Partner information is only available to partner accounts." });
  const orgId = actor.organizationId;
  const [{ data: org }, { data: venues }] = await Promise.all([
    db.from("organizations").select("id,name").eq("id", orgId).maybeSingle(),
    db.from("venues").select("name,city,state,venue_type,published,kiosks(state,installed_at)").eq("organization_id", orgId).limit(100),
  ]);
  type V = { name: string; city: string; state: string; venue_type: string; published: boolean; kiosks: { state: string; installed_at: string | null }[] | null };
  const list = (venues ?? []) as unknown as V[];
  let online = 0, total = 0;
  for (const v of list) for (const k of v.kiosks ?? []) { total++; if (k.state === "online" && k.installed_at) online++; }
  return ok({
    organization: (org as { name?: string } | null)?.name ?? null,
    venues: list.map((v) => ({ name: v.name, city: v.city, state: v.state, venueType: v.venue_type, published: v.published })),
    stations: { total, online },
    note: "Placement and commercial terms are private; direct partnership questions to a support ticket.",
  });
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

export const ACCOUNT_TOOL_NAMES = new Set([
  "get_my_active_rentals", "get_my_rental_history", "get_my_rental_details", "get_my_payment_status",
  "get_my_support_tickets", "get_my_support_ticket_details", "create_my_support_ticket",
  "add_my_ticket_message", "request_human_support", "get_my_partner_information",
]);

export const ACCOUNT_TOOLS: ToolDef[] = [
  { type: "function", function: { name: "get_my_active_rentals", description: "List the signed-in customer's currently open rentals (authorized, in progress, or not yet returned) with station and amounts so far.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_my_rental_history", description: "List the signed-in customer's most recent completed rentals.", parameters: { type: "object", properties: { limit: { type: "number", description: "Max results, default 10" } } } } },
  { type: "function", function: { name: "get_my_rental_details", description: "Full details for one of the signed-in customer's rentals by reference (ZR-XXXXXXXX).", parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] } } },
  { type: "function", function: { name: "get_my_payment_status", description: "Payment state and amounts (authorized/captured/refunded) for one of the signed-in customer's rentals. Never includes card data.", parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] } } },
  { type: "function", function: { name: "get_my_support_tickets", description: "List the signed-in user's support tickets (summary only).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_my_support_ticket_details", description: "Status and public (non-internal) messages for one of the signed-in user's tickets.", parameters: { type: "object", properties: { number: { type: "string", description: "Ticket number like Z-1234" } }, required: ["number"] } } },
  { type: "function", function: { name: "create_my_support_ticket", description: "Open a new support ticket for the signed-in user. Use when they describe a problem that needs a human or isn't answered by articles.", parameters: { type: "object", properties: {
    category: { type: "string", description: "One of the standard ticket categories, or Other" },
    subject: { type: "string" },
    body: { type: "string", description: "The customer's issue, plain text, max 2000 characters" } }, required: ["body"] } } },
  { type: "function", function: { name: "add_my_ticket_message", description: "Add a reply to an existing ticket owned by the signed-in user.", parameters: { type: "object", properties: {
    number: { type: "string" }, body: { type: "string" } }, required: ["number", "body"] } } },
  { type: "function", function: { name: "request_human_support", description: "Escalate to a human agent: flags the user's open ticket, or opens one if none exists.", parameters: { type: "object", properties: { reason: { type: "string" } } } } },
  { type: "function", function: { name: "get_my_partner_information", description: "Partner-only: organization name, venue names/cities/types, and station counts online. No financials.", parameters: { type: "object", properties: {} } } },
];

/** Runs one account tool. Returns a JSON string; unknown names return an error payload. */
export async function runAccountTool(name: string, db: SupabaseClient, actor: SessionUser, args: Record<string, unknown>): Promise<string> {
  // Tool name + outcome + latency only — args and results can contain customer data.
  const traceId = newTraceId();
  const start = performance.now();
  const finish = (out: string, outcome: "ok" | "error") => {
    const durationMs = Math.round(performance.now() - start);
    recordSpan({ traceId, name: `ai.account_tool.${name}`, service: "ai-assistant", kind: "internal", startMs: start, durationMs, status: outcome, attrs: { tool: name, outcome } });
    logTool(name, outcome, durationMs, traceId);
    return out;
  };
  try {
    let out: string;
    switch (name) {
      case "get_my_active_rentals": out = await getMyActiveRentals(db, actor); break;
      case "get_my_rental_history": out = await getMyRentalHistory(db, actor, args); break;
      case "get_my_rental_details": out = await getMyRentalDetails(db, actor, args); break;
      case "get_my_payment_status": out = await getMyPaymentStatus(db, actor, args); break;
      case "get_my_support_tickets": out = await getMySupportTickets(db, actor); break;
      case "get_my_support_ticket_details": out = await getMySupportTicketDetails(db, actor, args); break;
      case "create_my_support_ticket": out = await createMySupportTicket(db, actor, args); break;
      case "add_my_ticket_message": out = await addMyTicketMessage(db, actor, args); break;
      case "request_human_support": out = await requestHumanSupport(db, actor, args); break;
      case "get_my_partner_information": out = await getMyPartnerInformation(db, actor); break;
      default: return finish(JSON.stringify({ error: "Unknown tool." }), "error");
    }
    return finish(out, out.includes('"error"') ? "error" : "ok");
  } catch (e) {
    finish("", "error");
    console.error(JSON.stringify({ level: "error", scope: "ai-account-tool", msg: "tool_failed", tool: name, err: e instanceof Error ? e.message : "unknown" }));
    return JSON.stringify({ error: "That account lookup failed. Try again or open a ticket." });
  }
}

/** Extra system-prompt block appended only for signed-in users. */
export const ACCOUNT_SYSTEM_NOTE = (role: string) =>
  `The user is signed in (role: ${role}). You have account tools that return ONLY this user's own rentals, payments, tickets and partner info — identity is already verified server-side, so never ask for their password, SMS/email code, card number, or email to look anything up. Use the account tools when they ask about their own rentals, charges, tickets, or (partners) their venues; use the public tools for general questions. If an account tool returns an error, say so honestly and suggest /account or opening a ticket. Never reveal or discuss other customers' data.`;
