import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgreementStatus } from "./vending-agreements";

/**
 * Vending operations aggregation + partner service requests (migration 0071).
 * Server-only: callers pass the service client. Every dashboard section is
 * fault-isolated — a missing/failed table degrades that section to null or an
 * honest "unavailable" marker instead of breaking the whole page.
 */

/* ─── Dashboard types ─────────────────────────────────────────────────────── */

export type SectionUnavailable = { status: "unavailable"; reason: string };

export type PlacementSection = {
  inquiries30d: number;
  stageCounts: Record<string, number>;
  recent: { id: string; business_name: string | null; stage: string | null; created_at: string }[];
};

export type UnitsSection = {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
};

export type ModelsSection = { total: number; byStatus: Record<string, number> };

export type SourcingSection = { planned: number; sourcing: number; ordered: number; received: number };

export type InstallationRow = { unitId: string; label: string; venueName: string | null; status: string };
export type InstallationsSection = { assigned: number; installed: number; upcoming: InstallationRow[] };

export type RestockSection = { planned: number; inProgress: number; nextScheduled: string | null };

export type ServiceRequestSection = {
  open: number;
  urgentOpen: number;
  recent: { id: string; category: string; priority: string; status: string; created_at: string; venueName: string | null }[];
};

export type InventorySection = { activeSkus: number; lowStockSkus: number };

export type AgreementsSection = { active: number; drafts: number; superseded: number; terminated: number };

/** Charging-line partner earnings from commission_ledgers/payout_records — NOT vending revenue. */
export type PartnerEarningsSection = {
  productLine: "charging";
  ledgerPeriods: number;
  grossCents: number;
  commissionCents: number;
  payouts: { scheduled: number; paid: number; failed: number; paidCents: number; scheduledCents: number };
};

export type VendingOpsDashboard = {
  generatedAt: string;
  placement: PlacementSection | null;
  units: UnitsSection | null;
  models: ModelsSection | null;
  sourcing: SourcingSection | null;
  installations: InstallationsSection | null;
  restock: RestockSection | null;
  serviceRequests: ServiceRequestSection | null;
  inventory: InventorySection | null;
  agreements: AgreementsSection | null;
  revenue: SectionUnavailable;
  partnerEarnings: PartnerEarningsSection | null;
};

const OPEN_REQUEST_STATUSES = ["new", "acknowledged", "scheduled"] as const;
const DAY_MS = 86400_000;
const count = <T,>(rows: T[], key: (r: T) => string | null | undefined) => {
  const out: Record<string, number> = {};
  for (const r of rows) { const k = key(r) ?? "unknown"; out[k] = (out[k] ?? 0) + 1; }
  return out;
};

async function section<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

/**
 * Loads every ops-dashboard section independently. `now` is injectable for tests.
 * Vending transaction revenue does not exist yet — `revenue` is an honest
 * unavailable marker; charger economics live at /admin/profitability.
 */
export async function loadVendingOpsDashboard(db: SupabaseClient, now = new Date()): Promise<VendingOpsDashboard> {
  const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const nowIso = now.toISOString();

  const [placement, units, models, sourcing, installations, restock, serviceRequests, inventory, agreements, partnerEarnings] = await Promise.all([
    section(async (): Promise<PlacementSection> => {
      const { data, error } = await db.from("partner_applications")
        .select("id,business_name,placement_stage,created_at").limit(2000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; business_name: string | null; placement_stage: string | null; created_at: string }[];
      return {
        inquiries30d: rows.filter((r) => r.created_at >= since30).length,
        stageCounts: count(rows, (r) => r.placement_stage),
        recent: rows.slice(0, 8).map((r) => ({ id: r.id, business_name: r.business_name, stage: r.placement_stage, created_at: r.created_at })),
      };
    }),
    section(async (): Promise<UnitsSection> => {
      const { data, error } = await db.from("equipment_units")
        .select("id,status,category,venue_id").limit(5000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; status: string | null; category: string | null }[];
      return {
        total: rows.length,
        byStatus: count(rows, (r) => r.status),
        byCategory: count(rows, (r) => r.category),
      };
    }),
    section(async (): Promise<ModelsSection> => {
      const { data, error } = await db.from("equipment_models").select("id,status").limit(2000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; status: string | null }[];
      return { total: rows.length, byStatus: count(rows, (r) => r.status) };
    }),
    section(async (): Promise<SourcingSection> => {
      const { data, error } = await db.from("equipment_units").select("status").in("status", ["planned", "sourcing", "ordered", "received"]).limit(2000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { status: string | null }[];
      const c = count(rows, (r) => r.status);
      return { planned: c.planned ?? 0, sourcing: c.sourcing ?? 0, ordered: c.ordered ?? 0, received: c.received ?? 0 };
    }),
    section(async (): Promise<InstallationsSection> => {
      const { data, error } = await db.from("equipment_units")
        .select("id,status,category,model_label,serial_number,venue_id")
        .in("status", ["assigned", "installed"]).not("venue_id", "is", null).limit(500);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; status: string; category: string | null; model_label: string | null; serial_number: string | null; venue_id: string | null }[];
      const venueIds = [...new Set(rows.map((r) => r.venue_id).filter((v): v is string => Boolean(v)))];
      const venueNames = new Map<string, string>();
      if (venueIds.length) {
        const { data: vs } = await db.from("venues").select("id,name").in("id", venueIds).limit(500);
        for (const v of (vs ?? []) as { id: string; name: string }[]) venueNames.set(v.id, v.name);
      }
      const label = (r: (typeof rows)[number]) => r.model_label ?? r.serial_number ?? `${r.category ?? "unit"} unit`;
      return {
        assigned: rows.filter((r) => r.status === "assigned").length,
        installed: rows.filter((r) => r.status === "installed").length,
        upcoming: rows.slice(0, 10).map((r) => ({ unitId: r.id, label: label(r), venueName: r.venue_id ? venueNames.get(r.venue_id) ?? null : null, status: r.status })),
      };
    }),
    section(async (): Promise<RestockSection> => {
      const { data, error } = await db.from("restock_visits")
        .select("id,status,scheduled_for").in("status", ["planned", "in_progress"]).limit(1000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { status: string | null; scheduled_for: string | null }[];
      const upcoming = rows.map((r) => r.scheduled_for).filter((d): d is string => Boolean(d)).sort();
      return {
        planned: rows.filter((r) => r.status === "planned").length,
        inProgress: rows.filter((r) => r.status === "in_progress").length,
        nextScheduled: upcoming[0] ?? null,
      };
    }),
    section(async (): Promise<ServiceRequestSection> => {
      const { data, error } = await db.from("service_requests")
        .select("id,venue_id,category,priority,status,created_at")
        .in("status", [...OPEN_REQUEST_STATUSES]).order("created_at", { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; venue_id: string | null; category: string; priority: string; status: string; created_at: string }[];
      const venueIds = [...new Set(rows.map((r) => r.venue_id).filter((v): v is string => Boolean(v)))];
      const venueNames = new Map<string, string>();
      if (venueIds.length) {
        const { data: vs } = await db.from("venues").select("id,name").in("id", venueIds).limit(500);
        for (const v of (vs ?? []) as { id: string; name: string }[]) venueNames.set(v.id, v.name);
      }
      return {
        open: rows.length,
        urgentOpen: rows.filter((r) => r.priority === "urgent").length,
        recent: rows.slice(0, 8).map((r) => ({ id: r.id, category: r.category, priority: r.priority, status: r.status, created_at: r.created_at, venueName: r.venue_id ? venueNames.get(r.venue_id) ?? null : null })),
      };
    }),
    section(async (): Promise<InventorySection> => {
      const [skus, stock] = await Promise.all([
        db.from("product_skus").select("id,reorder_point,active").limit(2000),
        db.from("stock_levels").select("sku_id,qty").limit(10000),
      ]);
      if (skus.error || stock.error) throw new Error(skus.error?.message ?? stock.error?.message);
      const skuRows = (skus.data ?? []) as { id: string; reorder_point: number | null; active: boolean | null }[];
      const qtyBySku = new Map<string, number>();
      for (const s of (stock.data ?? []) as { sku_id: string; qty: number | null }[]) {
        qtyBySku.set(s.sku_id, (qtyBySku.get(s.sku_id) ?? 0) + (s.qty ?? 0));
      }
      const active = skuRows.filter((s) => s.active !== false);
      return {
        activeSkus: active.length,
        lowStockSkus: active.filter((s) => (qtyBySku.get(s.id) ?? 0) <= (s.reorder_point ?? 0)).length,
      };
    }),
    section(async (): Promise<AgreementsSection> => {
      const { data, error } = await db.from("equipment_agreements").select("id,status").limit(2000);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { id: string; status: string | null }[];
      const c = count(rows, (r) => (r.status && isAgreementStatus(r.status) ? r.status : "unknown"));
      return { active: c.active ?? 0, drafts: c.draft ?? 0, superseded: c.superseded ?? 0, terminated: c.terminated ?? 0 };
    }),
    section(async (): Promise<PartnerEarningsSection> => {
      const [ledgers, payouts] = await Promise.all([
        db.from("commission_ledgers").select("period,gross_cents,commission_cents").limit(1000),
        db.from("payout_records").select("amount_cents,status").limit(1000),
      ]);
      if (ledgers.error || payouts.error) throw new Error(ledgers.error?.message ?? payouts.error?.message);
      const lrows = (ledgers.data ?? []) as { period: string | null; gross_cents: number | null; commission_cents: number | null }[];
      const prows = (payouts.data ?? []) as { amount_cents: number | null; status: string | null }[];
      return {
        productLine: "charging",
        ledgerPeriods: new Set(lrows.map((l) => l.period).filter(Boolean)).size,
        grossCents: lrows.reduce((a, l) => a + (l.gross_cents ?? 0), 0),
        commissionCents: lrows.reduce((a, l) => a + (l.commission_cents ?? 0), 0),
        payouts: {
          scheduled: prows.filter((p) => p.status === "scheduled").length,
          paid: prows.filter((p) => p.status === "paid").length,
          failed: prows.filter((p) => p.status === "failed").length,
          paidCents: prows.filter((p) => p.status === "paid").reduce((a, p) => a + (p.amount_cents ?? 0), 0),
          scheduledCents: prows.filter((p) => p.status === "scheduled" || p.status === "approved").reduce((a, p) => a + (p.amount_cents ?? 0), 0),
        },
      };
    }),
  ]);

  return {
    generatedAt: nowIso,
    placement,
    units,
    models,
    sourcing,
    installations,
    restock,
    serviceRequests,
    inventory,
    agreements,
    revenue: { status: "unavailable", reason: "No vending transaction integration" },
    partnerEarnings,
  };
}

/* ─── Partner service requests ────────────────────────────────────────────── */

export const SERVICE_REQUEST_CATEGORIES = ["general", "restock", "repair", "equipment", "billing", "other"] as const;
export type ServiceRequestCategory = (typeof SERVICE_REQUEST_CATEGORIES)[number];
export const isServiceRequestCategory = (s: string): s is ServiceRequestCategory => (SERVICE_REQUEST_CATEGORIES as readonly string[]).includes(s);
export const SERVICE_REQUEST_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ServiceRequestPriority = (typeof SERVICE_REQUEST_PRIORITIES)[number];
export const isServiceRequestPriority = (s: string): s is ServiceRequestPriority => (SERVICE_REQUEST_PRIORITIES as readonly string[]).includes(s);

export type ServiceRequestRow = {
  id: string;
  venue_id: string;
  unit_id: string | null;
  category: string;
  description: string;
  priority: string;
  status: string;
  requested_by: string | null;
  created_at: string;
};

export type ServiceRequestResult = { ok: true; request: ServiceRequestRow } | { ok: false; error: string };

/** Venue ids owned by an org — the two-layer scope used by all partner queries. */
export async function orgVenueIds(db: SupabaseClient, orgId: string): Promise<string[]> {
  const { data } = await db.from("venues").select("id").eq("organization_id", orgId).limit(500);
  return ((data ?? []) as { id: string }[]).map((v) => v.id);
}

/**
 * Files a service request for a partner org. The venue MUST belong to the org
 * (checked server-side — RLS is the second layer, not the only one). When a
 * unit is picked it must sit at that venue. requested_by = the partner's user id.
 */
export async function createServiceRequestForOrg(
  db: SupabaseClient,
  orgId: string,
  userId: string,
  input: { venue_id: string; unit_id?: string | null; category: string; description: string; priority?: string | null },
): Promise<ServiceRequestResult> {
  const description = input.description?.trim() ?? "";
  if (description.length < 10 || description.length > 3000) return { ok: false, error: "Describe the issue (10–3000 characters)." };
  const category = isServiceRequestCategory(input.category) ? input.category : "general";
  const priority = input.priority && isServiceRequestPriority(input.priority) ? input.priority : "normal";

  const { data: venue, error: vErr } = await db.from("venues")
    .select("id,organization_id").eq("id", input.venue_id).maybeSingle();
  if (vErr || !venue) return { ok: false, error: "Unknown venue." };
  if ((venue as { organization_id?: string | null }).organization_id !== orgId) {
    return { ok: false, error: "That venue doesn't belong to your organization." };
  }

  let unitId: string | null = null;
  if (input.unit_id) {
    const { data: unit } = await db.from("equipment_units")
      .select("id,venue_id").eq("id", input.unit_id).maybeSingle();
    if (!unit || (unit as { venue_id?: string | null }).venue_id !== input.venue_id) {
      return { ok: false, error: "That unit isn't installed at the selected venue." };
    }
    unitId = input.unit_id;
  }

  const { data, error } = await db.from("service_requests").insert({
    venue_id: input.venue_id,
    unit_id: unitId,
    category,
    description,
    priority,
    status: "new",
    requested_by: userId,
  }).select("*").single();
  if (error || !data) return { ok: false, error: "The request could not be submitted." };
  return { ok: true, request: data as ServiceRequestRow };
}

/** Lists service requests for every venue owned by the org (newest first). */
export async function listOrgServiceRequests(db: SupabaseClient, orgId: string, limit = 200): Promise<ServiceRequestRow[]> {
  const venueIds = await orgVenueIds(db, orgId);
  if (!venueIds.length) return [];
  const { data, error } = await db.from("service_requests")
    .select("id,venue_id,unit_id,category,description,priority,status,requested_by,created_at")
    .in("venue_id", venueIds).order("created_at", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return data as ServiceRequestRow[];
}
