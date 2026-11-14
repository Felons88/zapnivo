import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CSV export catalogue for GET /api/admin/export?type=…
 *
 * Two shapes:
 *  - row exports: { table, select, order } — operational columns only.
 *    Customer emails/names/phones, message bodies, token/code hashes and
 *    receipt emails are deliberately never selected (see route comment).
 *  - aggregate exports: { table, aggregate: { columns } } — groups rows by the
 *    listed dimension columns and emits { …dims, count } rows. Used where a raw
 *    row dump would be meaningless or carry identifiers (e.g. newsletter).
 */

export type ExportDef =
  | { table: string; select: string; order: string }
  | { table: string; aggregate: { columns: string[] } };

export const EXPORTS: Record<string, ExportDef> = {
  rentals: { table: "rentals", select: "reference,state,started_at,dispensed_at,returned_at,non_return_deadline,created_at", order: "created_at" },
  payments: { table: "payments", select: "state,amount_authorized_cents,amount_captured_cents,currency,captured_at,created_at", order: "created_at" },
  payouts: { table: "payout_records", select: "amount_cents,status,paid_at,created_at", order: "created_at" },
  ledgers: { table: "commission_ledgers", select: "period,gross_cents,commission_cents,created_at", order: "period" },
  tickets: { table: "support_tickets", select: "ticket_number,category,state,priority,created_at,resolved_at", order: "created_at" },
  kiosks: { table: "kiosks", select: "station_id,state,model,firmware_version,last_seen_at,installed_at,slot_count", order: "created_at" },

  // Phase 5 additions — operational entities, no customer PII.
  memberships: { table: "customer_memberships", select: "plan_id,status,current_period_end,cancel_at_period_end,last_granted_period_end,created_at,updated_at", order: "created_at" },
  membership_plans: { table: "membership_plans", select: "id,name,interval,price_cents,benefit,active,created_at", order: "created_at" },
  gifts: { table: "gift_credits", select: "package,value_cents,status,expires_at,redeemed_at,refunded_at,created_at", order: "created_at" },
  ad_campaigns: { table: "advertising_campaigns", select: "name,advertiser,status,payment_status,pricing_model,budget_cents,spent_cents,created_at", order: "created_at" },
  sponsor_campaigns: { table: "sponsor_campaigns", select: "name,sponsor_name,status,credit_minutes,budget_cents,spent_cents,starts_at,ends_at,created_at", order: "created_at" },
  ad_billing: { table: "ad_ledger", select: "campaign_id,kind,amount_cents,currency,status,created_at", order: "created_at" },
  rental_exceptions: { table: "rental_exceptions", select: "kind,status,reopened_count,created_at,resolved_at,updated_at", order: "created_at" },
  device_events: { table: "device_events", select: "kiosk_id,event_type,slot_number,occurred_at", order: "occurred_at" },
  // Aggregate only — subscriber emails/tokens are never exported.
  newsletter: { table: "newsletter_subscribers", aggregate: { columns: ["status", "segment", "source"] } },
};

export type ExportResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; status: number; error: string };

/**
 * Runs one export. Row defs select up to 10k rows ordered desc; aggregate defs
 * select the dimension columns (capped at 10k source rows — beyond that the
 * counts are a sample and the route's row count reflects emitted groups).
 */
export async function runExport(db: SupabaseClient, type: string): Promise<ExportResult> {
  const def = EXPORTS[type];
  if (!def) return { ok: false, status: 400, error: `type must be one of: ${Object.keys(EXPORTS).join(", ")}` };

  if ("aggregate" in def) {
    const cols = def.aggregate.columns;
    const { data, error } = await db
      .from(def.table)
      .select(cols.join(","))
      .limit(10000);
    if (error) return { ok: false, status: 500, error: "Export failed." };
    const counts = new Map<string, Record<string, unknown>>();
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const key = cols.map((c) => String(r[c] ?? "")).join("");
      const row = counts.get(key) ?? { ...Object.fromEntries(cols.map((c) => [c, r[c] ?? null])), count: 0 };
      row.count = (row.count as number) + 1;
      counts.set(key, row);
    }
    return { ok: true, rows: [...counts.values()] };
  }

  const { data, error } = await db.from(def.table).select(def.select).order(def.order, { ascending: false }).limit(10000);
  if (error) return { ok: false, status: 500, error: "Export failed." };
  return { ok: true, rows: (data ?? []) as unknown as Record<string, unknown>[] };
}
