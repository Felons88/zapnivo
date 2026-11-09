import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "./supabase";

/**
 * Live operations stats for the internal console. Every figure comes from a real
 * table — a failed query degrades to null (rendered as "—"), never a made-up number.
 * Server-only: serviceClient uses the service-role key.
 */

type Counts = Record<string, number>;

/** Counts rows grouped by a single column. Null on error. */
async function countBy(db: SupabaseClient, table: string, col: string): Promise<Counts | null> {
  const { data, error } = await db.from(table).select(col).limit(5000);
  if (error || !data) return null;
  const out: Counts = {};
  for (const r of data as unknown as Record<string, unknown>[]) {
    const k = String(r[col] ?? "null");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Exact head-count with an optional filter callback. Null on error. */
async function headCount(db: SupabaseClient, table: string, where?: (q: any) => any): Promise<number | null> {
  let q = db.from(table).select("id", { count: "exact", head: true });
  if (where) q = where(q);
  const { count, error } = await q;
  return error ? null : count;
}

export const total = (c: Counts | null | undefined) => (c == null ? null : Object.values(c).reduce((a, b) => a + b, 0));
export const pick = (c: Counts | null | undefined, k: string) => c?.[k] ?? 0;

export type AdminStats = {
  kioskStates: Counts | null;
  slotStates: Counts | null;
  powerBanks: number | null;
  venues: Counts | null; // keyed by published true/false
  rentalStates: Counts | null;
  rentalsToday: number | null;
  revenueCents: { captured: number; refunded: number } | null;
  applicationStates: Counts | null;
  adInquiryStates: Counts | null;
  unhandledContacts: number | null;
  maintenanceVisits: number | null;
};

export async function getAdminStats(): Promise<AdminStats | null> {
  const db = serviceClient();
  if (!db) return null;

  const since = new Date(Date.now() - 86400_000).toISOString();

  const [kioskStates, slotStates, powerBanks, venues, rentalStates, rentalsToday, payments, applicationStates, adInquiryStates, unhandledContacts, maintenanceVisits] =
    await Promise.all([
      countBy(db, "kiosks", "state"),
      countBy(db, "kiosk_slots", "state"),
      headCount(db, "power_banks", (q) => q.eq("retired", false)),
      countBy(db, "venues", "published"),
      countBy(db, "rentals", "state"),
      headCount(db, "rentals", (q) => q.gte("created_at", since)),
      (async () => { try { const { data } = await db.from("payments").select("amount_captured_cents, amount_refunded_cents").limit(5000); return data; } catch { return null; } })(),
      countBy(db, "partner_applications", "status"),
      countBy(db, "advertising_inquiries", "state"),
      headCount(db, "contact_messages", (q) => q.eq("handled", false)),
      headCount(db, "maintenance_visits"),
    ]);

  const revenueCents = payments == null ? null : (payments as { amount_captured_cents: number | null; amount_refunded_cents: number | null }[]).reduce(
    (a, p) => ({ captured: a.captured + (p.amount_captured_cents ?? 0), refunded: a.refunded + (p.amount_refunded_cents ?? 0) }),
    { captured: 0, refunded: 0 },
  );

  return { kioskStates, slotStates, powerBanks, venues, rentalStates, rentalsToday, revenueCents, applicationStates, adInquiryStates, unhandledContacts, maintenanceVisits };
}
