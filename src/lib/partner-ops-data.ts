import type { SupabaseClient } from "@supabase/supabase-js";
import { derivePipeline, deviceStatusSummary, paymentWindowStats, pctDelta, rentalWindowStats } from "./partner-ops";

export type OrgOnboarding = {
  id: string; name: string;
  pipeline: ReturnType<typeof derivePipeline>;
  steps: Record<string, string>; // step -> completed_at
  docs: { id: string; kind: string; status: string; note: string | null; storage_path: string | null; requested_at: string; received_at: string | null }[];
};

/** Server-only loader (service client). Pass orgId to scope to one organization. */
export async function loadOnboarding(db: SupabaseClient, orgId?: string): Promise<OrgOnboarding[]> {
  const orgQ = db.from("organizations").select("id,name").order("name").limit(200);
  const { data: orgs } = orgId ? await orgQ.eq("id", orgId) : await orgQ;
  const list = (orgs ?? []) as { id: string; name: string }[];
  if (!list.length) return [];
  const ids = list.map((o) => o.id);
  const [apps, agreements, venues, steps, docs] = await Promise.all([
    db.from("partner_applications").select("business_name,status").in("status", ["approved", "installed"]).limit(1000),
    db.from("partner_agreements").select("organization_id").in("organization_id", ids).limit(2000),
    db.from("venues").select("id,organization_id,published,kiosks(installed_at)").in("organization_id", ids).limit(2000),
    db.from("partner_onboarding_steps").select("organization_id,step,completed_at").in("organization_id", ids),
    db.from("partner_document_requests").select("id,organization_id,kind,status,note,storage_path,requested_at,received_at").in("organization_id", ids).order("requested_at", { ascending: false }).limit(1000),
  ]);
  type V = { organization_id: string; published: boolean; kiosks: { installed_at: string | null }[] | null };
  return list.map((o) => {
    const vs = ((venues.data ?? []) as unknown as V[]).filter((v) => v.organization_id === o.id);
    return {
      id: o.id, name: o.name,
      pipeline: derivePipeline({
        orgName: o.name,
        applications: (apps.data ?? []) as { business_name: string; status: string }[],
        agreementCount: ((agreements.data ?? []) as { organization_id: string }[]).filter((a) => a.organization_id === o.id).length,
        venues: vs.map((v) => ({ published: v.published })),
        kiosks: vs.flatMap((v) => v.kiosks ?? []),
      }),
      steps: Object.fromEntries(((steps.data ?? []) as { organization_id: string; step: string; completed_at: string }[]).filter((s) => s.organization_id === o.id).map((s) => [s.step, s.completed_at])),
      docs: ((docs.data ?? []) as (OrgOnboarding["docs"][number] & { organization_id: string })[]).filter((d) => d.organization_id === o.id),
    };
  });
}

/* ─── Org-scoped partner performance report ─────────────────────────────── */

export type OrgReport = {
  orgId: string;
  generatedAt: string;
  venues: { id: string; name: string; published: boolean }[];
  current: { rentals: number; completed: number; utilizationPct: number | null; revenueCents: number; payments: number };
  prior: { rentals: number; completed: number; utilizationPct: number | null; revenueCents: number; payments: number };
  deltas: { rentalsPct: number | null; completedPct: number | null; revenuePct: number | null };
  commission: { grossCents: number; commissionCents: number; periods: number; latestPeriod: string | null };
  payouts: { count: number; scheduledCents: number; paidCents: number; failed: number };
  openTickets: number;
  devices: { total: number; online: number; stale: number; inactive: number };
};

const DAY_MS = 86400_000;
const EMPTY = { data: [] as never[], error: null };

/**
 * Loads the partner-facing performance report for ONE organization.
 * Every query is scoped through venueIds (venues.organization_id = orgId) or
 * organization_id directly — no cross-org data can leak.
 */
export async function loadOrgReport(db: SupabaseClient, orgId: string, now = new Date()): Promise<OrgReport> {
  const nowIso = now.toISOString();
  const curStart = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const prevStart = new Date(now.getTime() - 60 * DAY_MS).toISOString();

  const { data: venueData } = await db.from("venues").select("id,name,published").eq("organization_id", orgId).limit(200);
  const venues = ((venueData ?? []) as { id: string; name: string; published: boolean }[]);
  const venueIds = venues.map((v) => v.id);

  const scoped = venueIds.length > 0;
  const [rentals, payments, ledgers, payouts, tickets, devices] = await Promise.all([
    scoped
      ? db.from("rentals").select("state,created_at,kiosks!inner(venue_id)").in("kiosks.venue_id", venueIds).gte("created_at", prevStart).limit(10000)
      : Promise.resolve(EMPTY),
    scoped
      ? db.from("payments").select("amount_captured_cents,amount_refunded_cents,created_at,rentals!inner(kiosks!inner(venue_id))").in("rentals.kiosks.venue_id", venueIds).gte("created_at", prevStart).limit(10000)
      : Promise.resolve(EMPTY),
    scoped
      ? db.from("commission_ledgers").select("period,gross_cents,commission_cents").in("venue_id", venueIds).limit(500)
      : Promise.resolve(EMPTY),
    scoped
      ? db.from("payout_records").select("amount_cents,status,paid_at,created_at,commission_ledgers!inner(venue_id)").in("commission_ledgers.venue_id", venueIds).limit(500)
      : Promise.resolve(EMPTY),
    db.from("support_tickets").select("id,state").eq("organization_id", orgId).in("state", ["open", "pending_customer", "pending_internal"]).limit(500),
    scoped
      ? db.from("system_devices").select("status,last_heartbeat_at").in("venue_id", venueIds).limit(1000)
      : Promise.resolve(EMPTY),
  ]);

  const rentalRows = ((rentals as { data?: unknown }).data ?? []) as { state: string; created_at: string }[];
  const paymentRows = ((payments as { data?: unknown }).data ?? []) as { amount_captured_cents: number | null; amount_refunded_cents: number | null; created_at: string }[];
  const ledgerRows = ((ledgers as { data?: unknown }).data ?? []) as { period: string; gross_cents: number; commission_cents: number }[];
  const payoutRows = ((payouts as { data?: unknown }).data ?? []) as { amount_cents: number; status: string }[];
  const ticketRows = ((tickets as { data?: unknown }).data ?? []) as unknown[];
  const deviceRows = ((devices as { data?: unknown }).data ?? []) as { status: string; last_heartbeat_at: string | null }[];

  const curRentals = rentalWindowStats(rentalRows, curStart, nowIso);
  const priorRentals = rentalWindowStats(rentalRows, prevStart, curStart);
  const curPay = paymentWindowStats(paymentRows, curStart, nowIso);
  const priorPay = paymentWindowStats(paymentRows, prevStart, curStart);

  const commission = ledgerRows.reduce(
    (a, l) => ({ grossCents: a.grossCents + (l.gross_cents ?? 0), commissionCents: a.commissionCents + (l.commission_cents ?? 0), periods: a.periods + 1, latestPeriod: !a.latestPeriod || l.period > a.latestPeriod ? l.period : a.latestPeriod }),
    { grossCents: 0, commissionCents: 0, periods: 0, latestPeriod: null as string | null },
  );
  const payoutsAgg = payoutRows.reduce(
    (a, p) => ({
      count: a.count + 1,
      scheduledCents: a.scheduledCents + (p.status === "scheduled" ? p.amount_cents : 0),
      paidCents: a.paidCents + (p.status === "paid" ? p.amount_cents : 0),
      failed: a.failed + (p.status === "failed" ? 1 : 0),
    }),
    { count: 0, scheduledCents: 0, paidCents: 0, failed: 0 },
  );

  return {
    orgId,
    generatedAt: nowIso,
    venues,
    current: { ...curRentals, revenueCents: curPay.netCents, payments: curPay.payments },
    prior: { ...priorRentals, revenueCents: priorPay.netCents, payments: priorPay.payments },
    deltas: {
      rentalsPct: pctDelta(curRentals.rentals, priorRentals.rentals),
      completedPct: pctDelta(curRentals.completed, priorRentals.completed),
      revenuePct: pctDelta(curPay.netCents, priorPay.netCents),
    },
    commission,
    payouts: payoutsAgg,
    openTickets: ticketRows.length,
    devices: deviceStatusSummary(deviceRows, now),
  };
}
