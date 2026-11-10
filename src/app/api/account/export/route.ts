import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildExport, type PrivacyMessageRow, type PrivacyPaymentRow, type PrivacyRentalRow, type PrivacyTicketRow } from "@/lib/customer-privacy";
import { clientIp, fail } from "@/lib/helpdesk/http";
import { likeEscape } from "@/lib/customer";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const RENTAL_SELECT =
  "id,reference,state,renter_profile,customer_id,kiosk_id,power_bank_id,bank_count,promo_code,pricing_version,sms_consent,started_at,dispensed_at,returned_at,non_return_deadline,created_at,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(receipt_email)";
const PAYMENT_SELECT =
  "id,rental_id,state,amount_authorized_cents,amount_captured_cents,amount_refunded_cents,tax_cents,discount_cents,currency,receipt_email,customer_phone,captured_at,created_at";
const TICKET_SELECT =
  "id,ticket_number,rental_id,name,email,phone,rental_ref,station_label,category,description,state,priority,created_at,resolved_at";
const MESSAGE_SELECT = "id,ticket_id,author,internal,body,created_at";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const uniq = <T extends { id?: string }>(rows: T[]) => {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = r.id ?? JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * GDPR-style data export: JSON download of everything tied to the signed-in customer.
 * Every query is scoped to their auth user id / email, and buildExport re-filters rows in code.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  if (user.role !== "customer") return fail(403, "Data export is for customer accounts.");
  if (!rateLimit(`account-export:${user.id}:${clientIp(req)}`, 4, 60 * 60_000).ok) {
    return fail(429, "Too many export requests. Please try again later.", { code: "rate_limited" });
  }
  const db = serviceClient();
  if (!db) return fail(503, "Data export isn't available yet.", { code: "backend_unconfigured" });

  const owner = { id: user.id, email: user.email };
  const uid = UUID_RE.test(user.id) ? user.id : null;
  const email = user.email.toLowerCase();

  // 1) Profile row (only ever their own id).
  const profileRes = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();

  // 2) Rentals owned via profile links, plus rentals reached through receipt-email payments.
  const groups: PrivacyRentalRow[][] = [];
  if (uid) {
    const { data } = await db.from("rentals").select(RENTAL_SELECT).or(`renter_profile.eq.${uid},customer_id.eq.${uid}`).limit(500);
    groups.push((data ?? []) as unknown as PrivacyRentalRow[]);
  }
  if (email) {
    const { data: pays } = await db
      .from("payments")
      .select("rental_id")
      .ilike("receipt_email", likeEscape(email))
      .limit(500);
    const ids = [...new Set(((pays ?? []) as { rental_id: string }[]).map((p) => p.rental_id))];
    if (ids.length) {
      const { data } = await db.from("rentals").select(RENTAL_SELECT).in("id", ids).limit(500);
      groups.push((data ?? []) as unknown as PrivacyRentalRow[]);
    }
  }
  const rentals = uniq(groups.flat());
  const rentalIds = rentals.map((r) => r.id).filter((x): x is string => !!x);

  // 3) Payments on those rentals, plus any payment carrying their receipt email.
  const payGroups: PrivacyPaymentRow[][] = [];
  if (rentalIds.length) {
    const { data } = await db.from("payments").select(PAYMENT_SELECT).in("rental_id", rentalIds).limit(1000);
    payGroups.push((data ?? []) as unknown as PrivacyPaymentRow[]);
  }
  if (email) {
    const { data } = await db.from("payments").select(PAYMENT_SELECT).ilike("receipt_email", likeEscape(email)).limit(1000);
    payGroups.push((data ?? []) as unknown as PrivacyPaymentRow[]);
  }
  const payments = uniq(payGroups.flat());

  // 4) Tickets by email, plus tickets attached to their rentals.
  const ticketGroups: PrivacyTicketRow[][] = [];
  if (email) {
    const { data } = await db.from("support_tickets").select(TICKET_SELECT).ilike("email", likeEscape(email)).limit(500);
    ticketGroups.push((data ?? []) as unknown as PrivacyTicketRow[]);
  }
  if (rentalIds.length) {
    const { data } = await db.from("support_tickets").select(TICKET_SELECT).in("rental_id", rentalIds).limit(500);
    ticketGroups.push((data ?? []) as unknown as PrivacyTicketRow[]);
  }
  const tickets = uniq(ticketGroups.flat());
  const ticketIds = tickets.map((t) => t.id).filter((x): x is string => !!x);

  // 5) Messages on those tickets (internal staff notes are dropped in buildExport).
  let messages: PrivacyMessageRow[] = [];
  if (ticketIds.length) {
    const { data } = await db.from("support_messages").select(MESSAGE_SELECT).in("ticket_id", ticketIds).limit(2000);
    messages = (data ?? []) as unknown as PrivacyMessageRow[];
  }

  const payload = buildExport(owner, {
    profile: (profileRes.data ?? null) as Record<string, unknown> | null,
    rentals,
    payments,
    tickets,
    messages,
  });

  // Audit the export as a processed request (best-effort; never blocks the download).
  await db
    .from("customer_data_requests")
    .insert({ user_id: uid, email: user.email, kind: "export", status: "processed", processed_at: new Date().toISOString() })
    .then(() => undefined, () => undefined);

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="zapnivo-data-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
