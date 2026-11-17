import type { SupabaseClient } from "@supabase/supabase-js";
import { stripeCall, stripeConfigured } from "./stripe";
import { giftLaunchStatus } from "./gift-launch";

export type WalletTransaction = {
  id: string;
  kind: "rental" | "topup";
  title: string;
  subtitle: string;
  amount_cents: number;
  created_at: string;
  rental_ref?: string;
};

export type LinkedCard = {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  funding: string | null;
};

/** The balance comes only from active entitlement grants, net of reservations. */
export async function walletBalance(db: SupabaseClient, profileId: string): Promise<number | null> {
  const { data, error } = await db.from("entitlement_grants")
    .select("remaining,reserved,expires_at").eq("profile_id", profileId).eq("unit", "cent").eq("status", "active");
  if (error) return null;
  const now = Date.now();
  return ((data ?? []) as { remaining: number; reserved: number | null; expires_at: string | null }[])
    .filter((g) => !g.expires_at || Date.parse(g.expires_at) > now)
    .reduce((sum, g) => sum + Math.max(0, g.remaining - (g.reserved ?? 0)), 0);
}

export async function walletHistory(db: SupabaseClient, profileId: string): Promise<WalletTransaction[] | null> {
  const [rentals, topups] = await Promise.all([
    db.from("rentals").select("id,reference,dispensed_at,returned_at,created_at,kiosks!rentals_kiosk_id_fkey(venues(name,city)),payments(amount_captured_cents,amount_refunded_cents,state)")
      .or(`customer_id.eq.${profileId},renter_profile.eq.${profileId}`).order("created_at", { ascending: false }).limit(100),
    db.from("wallet_topups").select("id,amount_cents,status,created_at").eq("profile_id", profileId).eq("status", "paid").order("created_at", { ascending: false }).limit(100),
  ]);
  if (rentals.error) return null;
  type RentalRow = { id: string; reference: string; dispensed_at: string | null; returned_at: string | null; created_at: string; kiosks: { venues: { name: string; city: string } | null } | null; payments: { amount_captured_cents: number | null; amount_refunded_cents: number | null; state: string }[] };
  const charges: WalletTransaction[] = ((rentals.data ?? []) as unknown as RentalRow[]).flatMap((r) => {
    const captured = (r.payments ?? []).reduce((sum, p) => sum + (p.amount_captured_cents ?? 0), 0);
    const refunded = (r.payments ?? []).reduce((sum, p) => sum + (p.amount_refunded_cents ?? 0), 0);
    const net = Math.max(0, captured - refunded);
    if (net <= 0) return [];
    const duration = r.dispensed_at && r.returned_at
      ? `${Math.max(1, Math.ceil((Date.parse(r.returned_at) - Date.parse(r.dispensed_at)) / 3_600_000))} hr`
      : null;
    const place = r.kiosks?.venues?.name ?? "Zapnivo station";
    return [{ id: `rental-${r.id}`, kind: "rental" as const, title: `Charger at ${place}`, subtitle: [duration, r.kiosks?.venues?.city, r.reference].filter(Boolean).join(" · "), amount_cents: -net, created_at: r.returned_at ?? r.created_at, rental_ref: r.reference }];
  });
  const credits: WalletTransaction[] = topups.error ? [] : ((topups.data ?? []) as { id: string; amount_cents: number; created_at: string }[])
    .map((t) => ({ id: `topup-${t.id}`, kind: "topup", title: "Added funds", subtitle: "Zapnivo charging credit", amount_cents: t.amount_cents, created_at: t.created_at }));
  return [...charges, ...credits].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100);
}

/** Stripe returns display-safe card metadata only; never expose PAN or client secrets. */
export async function linkedCards(email: string): Promise<LinkedCard[] | null> {
  if (!stripeConfigured()) return null;
  const customers = await stripeCall<{ data?: { id: string }[] }>("GET", `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (!customers.ok) return null;
  const customerId = customers.data.data?.[0]?.id;
  if (!customerId) return [];
  const methods = await stripeCall<{ data?: { id: string; card?: { brand?: string; display_brand?: string; last4?: string; exp_month?: number; exp_year?: number; funding?: string } }[] }>("GET", `/payment_methods?customer=${encodeURIComponent(customerId)}&type=card&limit=30`);
  if (!methods.ok) return null;
  return (methods.data.data ?? []).filter((p) => p.card?.last4).map((p) => ({
    id: p.id, brand: p.card?.display_brand ?? p.card?.brand ?? "card", last4: p.card!.last4!,
    exp_month: p.card?.exp_month ?? 0, exp_year: p.card?.exp_year ?? 0, funding: p.card?.funding ?? null,
  }));
}

export const walletTopupsReady = () => giftLaunchStatus().status === "enabled" && stripeConfigured();
