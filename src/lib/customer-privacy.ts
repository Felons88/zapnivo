import { stripeCall, stripeConfigured } from "./stripe";
import { likeEscape } from "./customer";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Customer privacy helpers: data export shaping, ownership checks, session info, saved card.
 * Everything here is scoped to ONE authenticated customer — service-role queries bypass RLS,
 * so buildExport re-filters every row in code as a second line of defense.
 */

export type AccountOwner = { id: string; email: string };

/** A rental row as fetched for export: ownership may come via renter_profile, customer_id, or a payment's receipt_email. */
export type PrivacyRentalRow = Record<string, unknown> & {
  id?: string;
  renter_profile?: string | null;
  customer_id?: string | null;
  receipt_email?: string | null;
  payments?: unknown;
};

export type PrivacyPaymentRow = { id?: string; rental_id?: string | null; receipt_email?: string | null } & Record<string, unknown>;
export type PrivacyTicketRow = { id?: string; ticket_number?: string; rental_id?: string | null; email?: string | null } & Record<string, unknown>;
export type PrivacyMessageRow = { id?: string; ticket_id?: string | null; internal?: boolean | null } & Record<string, unknown>;

const payList = (p: unknown): { receipt_email?: string | null }[] =>
  Array.isArray(p) ? (p as { receipt_email?: string | null }[]) : p && typeof p === "object" ? [p as { receipt_email?: string | null }] : [];
const sameEmail = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** True when this rental belongs to the signed-in customer by ANY ownership path. */
export function rentalOwnedBy(r: PrivacyRentalRow, owner: AccountOwner): boolean {
  if (owner.id && (r.renter_profile === owner.id || r.customer_id === owner.id)) return true;
  const email = owner.email.toLowerCase();
  if (email && sameEmail(r.receipt_email, email)) return true;
  return payList(r.payments).some((p) => sameEmail(p.receipt_email, email));
}

export type ExportInput = {
  profile: (Record<string, unknown> & { id?: string }) | null;
  rentals: PrivacyRentalRow[];
  payments: PrivacyPaymentRow[];
  tickets: PrivacyTicketRow[];
  messages: PrivacyMessageRow[];
};

/**
 * Builds the customer's export. Even if the service-role queries returned another customer's
 * rows (bug or injection), every collection is re-filtered by ownership before it leaves the server.
 */
export function buildExport(owner: AccountOwner, input: ExportInput, now = new Date()) {
  const rentals = input.rentals.filter((r) => rentalOwnedBy(r, owner));
  const rentalIds = new Set(rentals.map((r) => r.id).filter((x): x is string => !!x));
  const email = owner.email.toLowerCase();

  const payments = input.payments.filter(
    (p) => (!!p.rental_id && rentalIds.has(p.rental_id)) || (!!email && sameEmail(p.receipt_email, email)),
  );

  const tickets = input.tickets.filter(
    (t) => (!!email && sameEmail(t.email, email)) || (!!t.rental_id && rentalIds.has(t.rental_id)),
  );
  const ticketIds = new Set(tickets.map((t) => t.id).filter((x): x is string => !!x));

  // Internal helpdesk notes are staff-only and never leave in a customer export.
  const messages = input.messages.filter((m) => !!m.ticket_id && ticketIds.has(m.ticket_id) && m.internal !== true);

  const profile = input.profile && input.profile.id === owner.id ? input.profile : null;

  return {
    exported_at: now.toISOString(),
    account: { id: owner.id, email: owner.email },
    profile,
    rentals,
    payments,
    tickets,
    messages,
  };
}

/** Fields cleared immediately on a deletion request; financial rows are retained (see migration 0017 notes). */
export const deletionAnonymization = { full_name: null, phone: null } as const;

/** Supabase auth users expose last_sign_in_at via the admin API; there is no session-list endpoint. */
export async function lastSignInAt(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return null;
    const v = (data.user as { last_sign_in_at?: string } | null)?.last_sign_in_at;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Decodes the exp claim of a JWT access token (no verification — the token was already verified by getSessionUser). */
export function jwtExpiry(token: string | null | undefined): string | null {
  try {
    const part = token?.split(".")[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString()) as { exp?: number };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

export type SessionActivity = {
  currentSession: { email: string; expiresAt: string | null };
  /** Honest limitation: Supabase exposes only the most recent sign-in, not a full session history. */
  lastSignInAt: string | null;
  note: string;
};

export function shapeSessionActivity(owner: AccountOwner, lastSignIn: string | null, accessToken: string | null | undefined): SessionActivity {
  return {
    currentSession: { email: owner.email, expiresAt: jwtExpiry(accessToken) },
    lastSignInAt: lastSignIn,
    note: "Your sign-in provider only exposes the most recent sign-in time — a full session history isn't available to us.",
  };
}

export type SavedCard = { brand: string; last4: string };

/**
 * Best-effort saved-card lookup. Checkout saves the card for off-session reuse, so the newest
 * payment's PaymentIntent usually carries a Customer + PaymentMethod. Returns null when Stripe
 * isn't configured or no saved method exists — callers must show an honest fallback, never a fake card.
 */
export async function fetchSavedCard(db: SupabaseClient, owner: AccountOwner): Promise<SavedCard | null> {
  if (!stripeConfigured()) return null;
  const email = owner.email.toLowerCase();
  const { data: pays } = await db
    .from("payments")
    .select("stripe_payment_intent_id")
    .ilike("receipt_email", likeEscape(email))
    .not("stripe_payment_intent_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const pi = (pays?.[0] as { stripe_payment_intent_id?: string } | undefined)?.stripe_payment_intent_id;
  if (!pi) return null;

  const piRes = await stripeCall<{ customer?: string | { id: string } | null; payment_method?: string | { id: string; card?: { brand?: string; last4?: string } } | null }>(
    "GET", `/payment_intents/${encodeURIComponent(pi)}?expand[]=payment_method&expand[]=customer`,
  );
  if (!piRes.ok) return null;
  const pm = piRes.data.payment_method;
  if (pm && typeof pm === "object" && pm.card?.brand && pm.card?.last4) {
    return { brand: pm.card.brand, last4: pm.card.last4 };
  }
  const pmId = typeof pm === "string" ? pm : pm && typeof pm === "object" ? pm.id : null;
  if (pmId) {
    const pmRes = await stripeCall<{ card?: { brand?: string; last4?: string } }>("GET", `/payment_methods/${encodeURIComponent(pmId)}`);
    if (pmRes.ok && pmRes.data.card?.brand && pmRes.data.card.last4) return { brand: pmRes.data.card.brand, last4: pmRes.data.card.last4 };
  }
  // Customer exists but the PI didn't carry a usable method — try the customer's saved methods.
  const customerId = typeof piRes.data.customer === "string" ? piRes.data.customer : piRes.data.customer?.id;
  if (customerId) {
    const list = await stripeCall<{ data?: { card?: { brand?: string; last4?: string } }[] }>(
      "GET", `/customers/${encodeURIComponent(customerId)}/payment_methods?type=card&limit=1`,
    );
    const card = list.ok ? list.data.data?.[0]?.card : null;
    if (card?.brand && card.last4) return { brand: card.brand, last4: card.last4 };
  }
  return null;
}
