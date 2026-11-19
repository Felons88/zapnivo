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

/**
 * Rows per UTC day for the last `days` days, keyed YYYY-MM-DD with zeros filled so
 * charts never have holes. Reads a single timestamp column; counts are real rows.
 */
async function dayCounts(db: SupabaseClient, table: string, col: string, days: number): Promise<Record<string, number> | null> {
  const { data, error } = await db.from(table).select(col).limit(5000);
  if (error || !data) return null;
  const now = Date.now();
  const out: Record<string, number> = {};
  for (let i = days - 1; i >= 0; i--) out[new Date(now - i * 86400_000).toISOString().slice(0, 10)] = 0;
  for (const r of data as unknown as Record<string, unknown>[]) {
    const v = r[col];
    if (typeof v === "string") {
      const day = v.slice(0, 10);
      if (day in out) out[day] += 1;
    }
  }
  return out;
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
  /** Rentals created per UTC day, last 14 days (YYYY-MM-DD → count). Null when unreadable. */
  rentalsByDay: Record<string, number> | null;
  /** Payments captured today (all-time table filtered to today's date). */
  revenueTodayCents: number | null;
  revenueTodayCount: number | null;
  /** Disputes not yet resolved/closed/won. */
  disputesOpen: number | null;
};

export async function getAdminStats(): Promise<AdminStats | null> {
  const db = serviceClient();
  if (!db) return null;

  const since = new Date(Date.now() - 86400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [kioskStates, slotStates, powerBanks, venues, rentalStates, rentalsToday, payments, applicationStates, adInquiryStates, unhandledContacts, maintenanceVisits, rentalsByDay, disputes] =
    await Promise.all([
      countBy(db, "kiosks", "state"),
      countBy(db, "kiosk_slots", "state"),
      headCount(db, "power_banks", (q) => q.eq("retired", false)),
      countBy(db, "venues", "published"),
      countBy(db, "rentals", "state"),
      headCount(db, "rentals", (q) => q.gte("created_at", since)),
      (async () => { try { const { data } = await db.from("payments").select("amount_captured_cents,amount_refunded_cents,captured_at").limit(5000); return data; } catch { return null; } })(),
      countBy(db, "partner_applications", "status"),
      countBy(db, "advertising_inquiries", "state"),
      headCount(db, "contact_messages", (q) => q.eq("handled", false)),
      headCount(db, "maintenance_visits"),
      dayCounts(db, "rentals", "created_at", 14),
      (async () => { try { const { data } = await db.from("disputes").select("status").limit(5000); return data; } catch { return null; } })(),
    ]);

  const revenueCents = payments == null ? null : (payments as { amount_captured_cents: number | null; amount_refunded_cents: number | null }[]).reduce(
    (a, p) => ({ captured: a.captured + (p.amount_captured_cents ?? 0), refunded: a.refunded + (p.amount_refunded_cents ?? 0) }),
    { captured: 0, refunded: 0 },
  );

  // Today's captured revenue: real rows only, filtered by the capture date.
  const todayRows = payments == null ? null : (payments as { amount_captured_cents: number | null; captured_at: string | null }[]).filter((p) => (p.captured_at ?? "").slice(0, 10) === today);
  const revenueTodayCents = todayRows == null ? null : todayRows.reduce((s, p) => s + (p.amount_captured_cents ?? 0), 0);
  const revenueTodayCount = todayRows == null ? null : todayRows.length;

  const disputesOpen = disputes == null ? null : disputes.filter((d) => !["resolved", "closed", "won"].includes(String((d as { status?: string }).status ?? ""))).length;

  return { kioskStates, slotStates, powerBanks, venues, rentalStates, rentalsToday, revenueCents, applicationStates, adInquiryStates, unhandledContacts, maintenanceVisits, rentalsByDay, revenueTodayCents, revenueTodayCount, disputesOpen };
}
