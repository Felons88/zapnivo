import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCommissionPct } from "./ledgers";

/**
 * Kiosk unit economics + venue placement intelligence — Phase 6.
 *
 * SERVER-ONLY: every export takes a service-role SupabaseClient. Never import
 * this module from a client component.
 *
 * HONESTY CONTRACT:
 *  - Observed figures (rental counts, captured revenue, active days) come
 *    straight from `rentals` / `payments` rows — nothing is seeded or invented.
 *  - Anything derived from `admin_finance_assumptions` is flagged
 *    `assumptionBased: true` and labelled in the UI.
 *  - Every section loads inside its own try/catch; failures degrade to
 *    null / "unavailable" entries, never to fabricated numbers.
 *  - Row counts are capped; `truncated: true` is reported when a cap is hit.
 */

/* ── Assumptions (admin_finance_assumptions, migration 0069) ──────────────── */

export const ASSUMPTION_DEFS = [
  { key: "kiosk.hardware_cost_cents", label: "Hardware purchase cost", unit: "usd_cents", numeric: true, def: 0, description: "One-time per-kiosk hardware cost (owner-entered assumption)." },
  { key: "kiosk.install_cost_cents", label: "Installation cost", unit: "usd_cents", numeric: true, def: 0, description: "One-time per-kiosk installation/commissioning (assumption)." },
  { key: "kiosk.connectivity_cost_cents", label: "Connectivity cost / month", unit: "usd_cents", numeric: true, def: 0, description: "Per-kiosk monthly connectivity (assumption)." },
  { key: "kiosk.software_alloc_cents", label: "Software allocation / month", unit: "usd_cents", numeric: true, def: 0, description: "Per-kiosk monthly software allocation (assumption)." },
  { key: "kiosk.bank_cost_cents", label: "Replacement power bank cost", unit: "usd_cents", numeric: true, def: 0, description: "Per-bank hardware cost for wear replacement (assumption)." },
  { key: "kiosk.maintenance_cost_cents", label: "Maintenance cost / month", unit: "usd_cents", numeric: true, def: 0, description: "Per-kiosk monthly maintenance reserve (assumption)." },
  { key: "placement.foot_traffic_index", label: "Foot-traffic data source", unit: "text", numeric: false, def: "unknown", description: "How venue traffic estimates are sourced (e.g. owner_estimate, third_party)." },
] as const;

export type AssumptionKey = (typeof ASSUMPTION_DEFS)[number]["key"];
export type AssumptionDef = (typeof ASSUMPTION_DEFS)[number];

/** Typed view of the numeric/text assumptions used by the economics math. */
export type Assumptions = {
  hardwareCostCents: number;
  installCostCents: number;
  connectivityCostCents: number;
  softwareAllocCents: number;
  bankCostCents: number;
  maintenanceCostCents: number;
  footTrafficIndex: string;
};

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  hardwareCostCents: 0,
  installCostCents: 0,
  connectivityCostCents: 0,
  softwareAllocCents: 0,
  bankCostCents: 0,
  maintenanceCostCents: 0,
  footTrafficIndex: "unknown",
};

const KEY_TO_FIELD: Record<AssumptionKey, keyof Assumptions> = {
  "kiosk.hardware_cost_cents": "hardwareCostCents",
  "kiosk.install_cost_cents": "installCostCents",
  "kiosk.connectivity_cost_cents": "connectivityCostCents",
  "kiosk.software_alloc_cents": "softwareAllocCents",
  "kiosk.bank_cost_cents": "bankCostCents",
  "kiosk.maintenance_cost_cents": "maintenanceCostCents",
  "placement.foot_traffic_index": "footTrafficIndex",
};

export type AssumptionRow = { key: string; value: unknown; label: string | null; unit: string | null; description: string | null; updated_at: string | null };

/**
 * Pure merge: DB rows win over defaults, but only when the value is valid
 * (finite non-negative number for numeric keys, non-empty string ≤120 chars
 * for the text key). Invalid/missing rows fall back to the default.
 */
export function assumptionsFromRows(rows: AssumptionRow[] | null | undefined): Assumptions {
  const out: Assumptions = { ...DEFAULT_ASSUMPTIONS };
  const byKey = new Map((rows ?? []).map((r) => [r.key, r.value]));
  for (const def of ASSUMPTION_DEFS) {
    const field = KEY_TO_FIELD[def.key];
    const raw = byKey.get(def.key);
    if (def.numeric) {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= 0) (out as Record<string, unknown>)[field] = n;
    } else {
      if (typeof raw === "string" && raw.trim().length > 0 && raw.length <= 120) {
        (out as Record<string, unknown>)[field] = raw.trim();
      }
    }
  }
  return out;
}

/** Loads assumptions; on any DB error returns defaults (degraded, never throws). */
export async function loadAssumptions(db: SupabaseClient): Promise<{ assumptions: Assumptions; degraded: boolean }> {
  try {
    const { data, error } = await db.from("admin_finance_assumptions").select("key,value").limit(100);
    if (error) return { assumptions: { ...DEFAULT_ASSUMPTIONS }, degraded: true };
    return { assumptions: assumptionsFromRows((data ?? []) as AssumptionRow[]), degraded: false };
  } catch {
    return { assumptions: { ...DEFAULT_ASSUMPTIONS }, degraded: true };
  }
}

export type AssumptionItem = {
  key: string; value: number | string; label: string; unit: string | null;
  description: string | null; updatedAt: string | null; source: "db" | "default";
};

/** All known assumption keys merged with DB rows — for the admin editor + GET. */
export async function listAssumptionItems(db: SupabaseClient | null): Promise<{ items: AssumptionItem[]; degraded: boolean }> {
  let rows: AssumptionRow[] = [];
  let degraded = false;
  if (db) {
    try {
      const { data, error } = await db.from("admin_finance_assumptions").select("key,value,label,unit,description,updated_at").limit(200);
      if (error) degraded = true; else rows = (data ?? []) as AssumptionRow[];
    } catch { degraded = true; }
  } else degraded = true;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const items: AssumptionItem[] = ASSUMPTION_DEFS.map((def) => {
    const row = byKey.get(def.key);
    const merged = assumptionsFromRows(row ? [row] : []);
    const field = KEY_TO_FIELD[def.key];
    return {
      key: def.key,
      value: merged[field] as number | string,
      label: row?.label ?? def.label,
      unit: row?.unit ?? def.unit,
      description: row?.description ?? def.description,
      updatedAt: row?.updated_at ?? null,
      source: row ? "db" : "default",
    };
  });
  // Surface any extra DB rows outside the known defs (still editable via API).
  for (const row of rows) {
    if (ASSUMPTION_DEFS.some((d) => d.key === row.key)) continue;
    items.push({
      key: row.key, value: row.value as number | string,
      label: row.label ?? row.key, unit: row.unit, description: row.description,
      updatedAt: row.updated_at, source: "db",
    });
  }
  return { items, degraded };
}

/* ── Shared fetch helpers ─────────────────────────────────────────────────── */

const PAGE = 1000;
const MAX_ROWS = 50_000;
const DAY_MS = 24 * 3600_000;

async function fetchAll<T>(
  queryFor: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; truncated: boolean } | { error: string }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await queryFor(from, from + PAGE - 1);
    if (error) return { error: error.message };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
    if (from + PAGE >= MAX_ROWS) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}

export type EconWindow = { days?: number; now?: Date };

function windowBounds(w: EconWindow): { days: number; since: string; until: string; startDay: string; endDay: string } {
  const days = Math.min(Math.max(Math.floor(w.days ?? 30), 7), 365);
  const now = w.now ?? new Date();
  const until = now.toISOString();
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  return { days, since, until, startDay: since.slice(0, 10), endDay: until.slice(0, 10) };
}

const netCents = (captured: number | null, refunded: number | null) =>
  Math.max(0, (captured ?? 0) - (refunded ?? 0));

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Pure payback math: one-time cost ÷ positive net monthly contribution.
 * Returns null whenever net monthly <= 0 (revenue doesn't cover costs) —
 * never negative, never Infinity, never NaN. 0 one-time cost → 0 months.
 */
export function estimatedPaybackMonths(oneTimeCents: number, netMonthlyCents: number): number | null {
  if (!Number.isFinite(oneTimeCents) || !Number.isFinite(netMonthlyCents)) return null;
  if (oneTimeCents < 0 || netMonthlyCents <= 0) return null;
  if (oneTimeCents === 0) return 0;
  const months = oneTimeCents / netMonthlyCents;
  return Number.isFinite(months) ? round1(months) : null;
}

/* ── Per-kiosk unit economics ─────────────────────────────────────────────── */

type KioskRow = {
  id: string; station_id: string | null; venue_id: string | null;
  model: string | null; state: string | null;
  venues?: { name: string | null; city: string | null; venue_type: string | null } | { name: string | null; city: string | null; venue_type: string | null }[] | null;
};
type RentalRow = { id: string; kiosk_id: string; started_at: string | null };
type PaymentRow = {
  rental_id: string; amount_captured_cents: number | null; amount_refunded_cents: number | null;
  captured_at: string | null;
  rentals?: { kiosk_id: string | null } | { kiosk_id: string | null }[] | null;
};

export type RevenueTrend = {
  firstHalfCents: number; secondHalfCents: number; deltaCents: number;
  direction: "up" | "down" | "flat";
};

export type KioskEconomics = {
  kioskId: string;
  stationId: string | null;
  venueId: string | null;
  venueName: string | null;
  venueCity: string | null;
  venueType: string | null;
  kioskState: string | null;
  model: string | null;
  /** Observed: rentals started in the window. */
  rentalCount: number;
  /** Observed: Σ(captured − refunded) on payments captured in the window. */
  grossRevenueCents: number;
  rentalsPerDay: number;
  /** Observed: gross / rentalCount; null when no rentals. */
  avgRentalValueCents: number | null;
  /** Observed: distinct days with ≥1 rental start. */
  activeDays: number;
  /** PROXY: activeDays / windowDays — not a real utilization meter. */
  utilizationProxy: number;
  /** Observed gross split into window halves. */
  revenueTrend: RevenueTrend;
  /* ── assumption-based (all flagged) ── */
  assumptionBased: true;
  /** Assumption: connectivity + software_alloc + maintenance, per month. */
  monthlyOpexCents: number;
  /** Assumption: hardware + install, one-time. */
  oneTimeCostCents: number;
  /** Estimate: gross × 30/windowDays — monthlyized observed revenue. */
  estimatedMonthlyGrossCents: number;
  /** Estimate: monthlyGross − monthlyOpex (may be negative). */
  netMonthlyContributionCents: number;
  /**
   * Estimate: oneTime / netMonthly. null when netMonthly <= 0 (revenue does
   * not cover assumed opex) — never negative, never Infinity.
   */
  estimatedPaybackMonths: number | null;
};

export type NetworkRollup = {
  kioskCount: number;
  rentalCount: number;
  grossRevenueCents: number;
  rentalsPerDay: number;
  activeKiosks: number;
  assumptionBased: true;
  monthlyOpexCents: number;          // opex × kioskCount (assumption)
  oneTimeCostCents: number;          // (hardware+install) × kioskCount (assumption)
  estimatedMonthlyGrossCents: number;
  netMonthlyContributionCents: number;
  estimatedPaybackMonths: number | null;
};

export type KioskEconomicsResult = {
  window: { days: number; start: string; end: string };
  assumptions: Assumptions;
  assumptionsDegraded: boolean;
  kiosks: KioskEconomics[];
  network: NetworkRollup | null;
  truncated: boolean;
  unavailable: string[];
};

export async function kioskUnitEconomics(db: SupabaseClient, window: EconWindow = {}): Promise<KioskEconomicsResult> {
  const wb = windowBounds(window);
  const unavailable: string[] = [];
  const { assumptions, degraded: assumptionsDegraded } = await loadAssumptions(db);

  // ── kiosks + venue labels ──
  let kioskRows: KioskRow[] = [];
  try {
    const { data, error } = await db
      .from("kiosks")
      .select("id,station_id,venue_id,model,state,venues(name,city,venue_type)")
      .limit(2000);
    if (error) throw new Error(error.message);
    kioskRows = (data ?? []) as unknown as KioskRow[];
  } catch { unavailable.push("kiosks"); }

  // ── rentals in window ──
  const rentalsRes = await fetchAll<RentalRow>((from, to) =>
    db.from("rentals")
      .select("id,kiosk_id,started_at")
      .not("started_at", "is", null)
      .gte("started_at", wb.since)
      .lte("started_at", wb.until)
      .order("started_at", { ascending: true })
      .range(from, to) as unknown as Promise<{ data: RentalRow[] | null; error: { message: string } | null }>,
  );
  const rentals = "rows" in rentalsRes ? rentalsRes.rows : null;
  if (!rentals) unavailable.push("rentals");

  // ── payments captured in window (attributed to kiosk via rental) ──
  const paymentsRes = await fetchAll<PaymentRow>((from, to) =>
    db.from("payments")
      .select("rental_id,amount_captured_cents,amount_refunded_cents,captured_at,rentals!inner(kiosk_id)")
      .not("captured_at", "is", null)
      .gte("captured_at", wb.since)
      .lte("captured_at", wb.until)
      .order("captured_at", { ascending: true })
      .range(from, to) as unknown as Promise<{ data: PaymentRow[] | null; error: { message: string } | null }>,
  );
  const payments = "rows" in paymentsRes ? paymentsRes.rows : null;
  if (!payments) unavailable.push("payments");

  const truncated = ("truncated" in rentalsRes && rentalsRes.truncated) || ("truncated" in paymentsRes && paymentsRes.truncated);

  // kiosk_id per payment
  const kioskOfPayment = (p: PaymentRow): string | null => {
    const r = p.rentals;
    const row = Array.isArray(r) ? r[0] : r;
    return row?.kiosk_id ?? null;
  };

  const midMs = (new Date(wb.since).getTime() + new Date(wb.until).getTime()) / 2;

  const monthlyOpex = assumptions.connectivityCostCents + assumptions.softwareAllocCents + assumptions.maintenanceCostCents;
  const oneTime = assumptions.hardwareCostCents + assumptions.installCostCents;
  const monthlyFactor = 30 / wb.days;

  const byKiosk = new Map<string, {
    rentalCount: number; activeDays: Set<string>; gross: number;
    firstHalf: number; secondHalf: number;
  }>();
  const slot = (id: string) => {
    let s = byKiosk.get(id);
    if (!s) { s = { rentalCount: 0, activeDays: new Set(), gross: 0, firstHalf: 0, secondHalf: 0 }; byKiosk.set(id, s); }
    return s;
  };

  for (const r of rentals ?? []) {
    if (!r.kiosk_id || !r.started_at) continue;
    const s = slot(r.kiosk_id);
    s.rentalCount += 1;
    s.activeDays.add(r.started_at.slice(0, 10));
  }
  for (const p of payments ?? []) {
    const kid = kioskOfPayment(p);
    if (!kid) continue;
    const cents = netCents(p.amount_captured_cents, p.amount_refunded_cents);
    if (cents <= 0) continue;
    const s = slot(kid);
    s.gross += cents;
    const t = p.captured_at ? Date.parse(p.captured_at) : NaN;
    if (Number.isFinite(t)) {
      if (t < midMs) s.firstHalf += cents; else s.secondHalf += cents;
    }
  }

  const venueOf = (k: KioskRow) => {
    const v = k.venues;
    return Array.isArray(v) ? v[0] ?? null : v ?? null;
  };

  const kiosks: KioskEconomics[] = kioskRows.map((k) => {
    const s = byKiosk.get(k.id) ?? { rentalCount: 0, activeDays: new Set<string>(), gross: 0, firstHalf: 0, secondHalf: 0 };
    const v = venueOf(k);
    const gross = s.gross;
    const rentalCount = s.rentalCount;
    const estimatedMonthlyGross = Math.round(gross * monthlyFactor);
    const netMonthly = estimatedMonthlyGross - monthlyOpex;
    const delta = s.secondHalf - s.firstHalf;
    // "flat" band: |delta| <= 5% of the larger half (or exactly 0 when both are 0)
    const band = Math.max(1, Math.round(0.05 * Math.max(s.firstHalf, s.secondHalf)));
    const direction: RevenueTrend["direction"] = delta > band ? "up" : delta < -band ? "down" : "flat";
    const payback = estimatedPaybackMonths(oneTime, netMonthly);
    return {
      kioskId: k.id,
      stationId: k.station_id,
      venueId: k.venue_id,
      venueName: v?.name ?? null,
      venueCity: v?.city ?? null,
      venueType: v?.venue_type ?? null,
      kioskState: k.state,
      model: k.model,
      rentalCount,
      grossRevenueCents: gross,
      rentalsPerDay: round3(rentalCount / wb.days),
      avgRentalValueCents: rentalCount > 0 ? Math.round(gross / rentalCount) : null,
      activeDays: s.activeDays.size,
      utilizationProxy: round3(s.activeDays.size / wb.days),
      revenueTrend: { firstHalfCents: s.firstHalf, secondHalfCents: s.secondHalf, deltaCents: delta, direction },
      assumptionBased: true,
      monthlyOpexCents: monthlyOpex,
      oneTimeCostCents: oneTime,
      estimatedMonthlyGrossCents: estimatedMonthlyGross,
      netMonthlyContributionCents: netMonthly,
      estimatedPaybackMonths: payback,
    };
  });

  // Kiosks referenced by rentals/payments but missing from the kiosks table.
  const known = new Set(kioskRows.map((k) => k.id));
  const orphans = new Set<string>();
  for (const r of rentals ?? []) if (r.kiosk_id && !known.has(r.kiosk_id)) orphans.add(r.kiosk_id);
  for (const p of payments ?? []) { const kid = kioskOfPayment(p); if (kid && !known.has(kid)) orphans.add(kid); }
  for (const id of orphans) {
    const s = byKiosk.get(id)!;
    const estimatedMonthlyGross = Math.round(s.gross * monthlyFactor);
    const netMonthly = estimatedMonthlyGross - monthlyOpex;
    kiosks.push({
      kioskId: id, stationId: null, venueId: null, venueName: null, venueCity: null, venueType: null,
      kioskState: null, model: null,
      rentalCount: s.rentalCount, grossRevenueCents: s.gross,
      rentalsPerDay: round3(s.rentalCount / wb.days),
      avgRentalValueCents: s.rentalCount > 0 ? Math.round(s.gross / s.rentalCount) : null,
      activeDays: s.activeDays.size, utilizationProxy: round3(s.activeDays.size / wb.days),
      revenueTrend: { firstHalfCents: s.firstHalf, secondHalfCents: s.secondHalf, deltaCents: s.secondHalf - s.firstHalf, direction: "flat" },
      assumptionBased: true, monthlyOpexCents: monthlyOpex, oneTimeCostCents: oneTime,
      estimatedMonthlyGrossCents: estimatedMonthlyGross, netMonthlyContributionCents: netMonthly,
      estimatedPaybackMonths: estimatedPaybackMonths(oneTime, netMonthly),
    });
  }

  // ── network rollup ──
  let network: NetworkRollup | null = null;
  if (kioskRows.length > 0 || kiosks.length > 0) {
    const rentalCount = kiosks.reduce((a, k) => a + k.rentalCount, 0);
    const gross = kiosks.reduce((a, k) => a + k.grossRevenueCents, 0);
    const activeKiosks = kiosks.filter((k) => k.rentalCount > 0).length;
    const nOpex = monthlyOpex * kiosks.length;
    const nOneTime = oneTime * kiosks.length;
    const nMonthlyGross = Math.round(gross * monthlyFactor);
    const nNet = nMonthlyGross - nOpex;
    network = {
      kioskCount: kiosks.length,
      rentalCount,
      grossRevenueCents: gross,
      rentalsPerDay: round3(rentalCount / wb.days),
      activeKiosks,
      assumptionBased: true,
      monthlyOpexCents: nOpex,
      oneTimeCostCents: nOneTime,
      estimatedMonthlyGrossCents: nMonthlyGross,
      netMonthlyContributionCents: nNet,
      estimatedPaybackMonths: estimatedPaybackMonths(nOneTime, nNet),
    };
  }

  return {
    window: { days: wb.days, start: wb.startDay, end: wb.endDay },
    assumptions, assumptionsDegraded,
    kiosks, network,
    truncated,
    unavailable,
  };
}

/* ── Venue placement intelligence ─────────────────────────────────────────── */

export const SCENARIO_DAYS = 30;

export type VenueOpportunity = {
  kind: "venue";
  id: string;
  name: string;
  city: string | null;
  venueType: string | null;
  organizationId: string | null;
  published: boolean;
  kioskCount: number;
  /** Observed in window. */
  observedRentals: number;
  observedRentalsPerDay: number;
  /** Observed: Σ(captured − refunded) attributed via kiosk → venue. */
  grossRevenueCents: number;
  /** Commission % from partner_agreements (venue-level, else org-level). */
  commissionPct: number | null;
  commissionSource: "agreement" | "network_average" | "none";
  /** "estimate" when network averages exist; "insufficient_data" otherwise. */
  scenarioStatus: "estimate" | "insufficient_data";
  /** Estimate: network-average rentals/day applied to this venue. */
  scenarioRentalsPerDay: number | null;
  scenarioDays: number;
  /** Estimate: scenario rentals × avg ticket (gross, before commission). */
  scenarioGrossCents: number | null;
  /** Estimate: scenario gross × (1 − commission%). null when no rate known. */
  scenarioNetCents: number | null;
  scenarioNote: string;
};

export type ApplicationOpportunity = {
  kind: "application";
  id: string;
  name: string;
  city: string | null;
  venueType: string | null;
  status: string;
  createdAt: string | null;
  kioskCount: 0;
  observedRentals: 0;
  observedRentalsPerDay: 0;
  grossRevenueCents: 0;
  commissionPct: null;
  scenarioStatus: "insufficient_data";
  scenarioRentalsPerDay: null;
  scenarioDays: number;
  scenarioGrossCents: null;
  scenarioNetCents: null;
  scenarioNote: string;
};

export type OpportunityResult = {
  window: { days: number; start: string; end: string };
  footTrafficIndex: string | null;
  /** Network-wide observed averages feeding every scenario (all estimates). */
  networkAvgRentalsPerDay: number | null;
  networkAvgTicketCents: number | null;
  networkAvgCommissionPct: number | null;
  venues: VenueOpportunity[];
  applications: ApplicationOpportunity[];
  truncated: boolean;
  unavailable: string[];
};

type VenueRow = {
  id: string; name: string; city: string | null; venue_type: string | null;
  organization_id: string | null; published: boolean | null;
};
type AgreementRow = { venue_id: string | null; organization_id: string; terms: unknown };
type ApplicationRow = {
  id: string; business_name: string; city: string | null; venue_type: string | null;
  status: string | null; created_at: string | null;
};
type VenueRentalRow = {
  kiosk_id: string | null;
  started_at: string | null;
  kiosks?: { venue_id: string | null } | { venue_id: string | null }[] | null;
};

export async function venueOpportunityAnalysis(db: SupabaseClient, window: EconWindow = {}): Promise<OpportunityResult> {
  const wb = windowBounds(window);
  const unavailable: string[] = [];
  const { assumptions } = await loadAssumptions(db);

  // ── venues, kiosks, agreements, applications (independent sections) ──
  let venues: VenueRow[] = [];
  try {
    const { data, error } = await db.from("venues").select("id,name,city,venue_type,organization_id,published").limit(2000);
    if (error) throw new Error(error.message);
    venues = (data ?? []) as VenueRow[];
  } catch { unavailable.push("venues"); }

  let kioskRows: { id: string; venue_id: string | null }[] = [];
  try {
    const { data, error } = await db.from("kiosks").select("id,venue_id").limit(2000);
    if (error) throw new Error(error.message);
    kioskRows = (data ?? []) as { id: string; venue_id: string | null }[];
  } catch { unavailable.push("kiosks"); }

  let agreements: AgreementRow[] = [];
  try {
    const { data, error } = await db.from("partner_agreements").select("venue_id,organization_id,terms").limit(2000);
    if (error) throw new Error(error.message);
    agreements = (data ?? []) as AgreementRow[];
  } catch { unavailable.push("partner_agreements"); }

  let applications: ApplicationRow[] = [];
  try {
    const { data, error } = await db.from("partner_applications")
      .select("id,business_name,city,venue_type,status,created_at")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    applications = (data ?? []) as ApplicationRow[];
  } catch { unavailable.push("partner_applications"); }

  // ── observed rentals per venue (via kiosk → venue) ──
  const rentalsRes = await fetchAll<VenueRentalRow>((from, to) =>
    db.from("rentals")
      .select("kiosk_id,started_at,kiosks!inner(venue_id)")
      .not("started_at", "is", null)
      .gte("started_at", wb.since)
      .lte("started_at", wb.until)
      .order("started_at", { ascending: true })
      .range(from, to) as unknown as Promise<{ data: VenueRentalRow[] | null; error: { message: string } | null }>,
  );
  const rentals = "rows" in rentalsRes ? rentalsRes.rows : null;
  if (!rentals) unavailable.push("rentals");

  // ── observed gross per venue: payments → rental → kiosk → venue ──
  const kioskVenue = new Map(kioskRows.map((k) => [k.id, k.venue_id]));
  const paymentsRes = await fetchAll<PaymentRow>((from, to) =>
    db.from("payments")
      .select("rental_id,amount_captured_cents,amount_refunded_cents,captured_at,rentals!inner(kiosk_id)")
      .not("captured_at", "is", null)
      .gte("captured_at", wb.since)
      .lte("captured_at", wb.until)
      .order("captured_at", { ascending: true })
      .range(from, to) as unknown as Promise<{ data: PaymentRow[] | null; error: { message: string } | null }>,
  );
  const payments = "rows" in paymentsRes ? paymentsRes.rows : null;
  if (!payments) unavailable.push("payments");

  const kioskOfPayment = (p: PaymentRow): string | null => {
    const r = p.rentals;
    const row = Array.isArray(r) ? r[0] : r;
    return row?.kiosk_id ?? null;
  };

  const rentalsByVenue = new Map<string, number>();
  let networkRentals = 0;
  for (const r of rentals ?? []) {
    const k = r.kiosks;
    const embed = Array.isArray(k) ? k[0] : k;
    const vid = embed?.venue_id ?? null;
    if (!vid) continue;
    networkRentals += 1;
    rentalsByVenue.set(vid, (rentalsByVenue.get(vid) ?? 0) + 1);
  }

  const grossByVenue = new Map<string, number>();
  let networkGross = 0;
  let paidRentals = 0;
  for (const p of payments ?? []) {
    const kid = kioskOfPayment(p);
    if (!kid) continue;
    const cents = netCents(p.amount_captured_cents, p.amount_refunded_cents);
    if (cents <= 0) continue;
    paidRentals += 1;
    networkGross += cents;
    const vid = kioskVenue.get(kid);
    if (vid) grossByVenue.set(vid, (grossByVenue.get(vid) ?? 0) + cents);
  }

  const truncated =
    ("truncated" in rentalsRes && rentalsRes.truncated) ||
    ("truncated" in paymentsRes && paymentsRes.truncated);

  /* ── network averages (feed every scenario — all labelled estimates) ── */
  const networkAvgRentalsPerDay = networkRentals > 0 ? round3(networkRentals / wb.days) : null;
  const networkAvgTicketCents = paidRentals > 0 ? Math.round(networkGross / paidRentals) : null;

  const pcts: number[] = [];
  for (const ag of agreements) {
    const pct = parseCommissionPct(ag.terms);
    if (pct !== null) pcts.push(pct);
  }
  const networkAvgCommissionPct = pcts.length > 0 ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;

  /* ── commission per venue: venue-level agreement, else org-level ── */
  const agreementFor = (venue: VenueRow): number | null => {
    const byVenue = agreements.find((a) => a.venue_id === venue.id);
    const ag = byVenue ?? agreements.find((a) => a.organization_id === venue.organization_id && !a.venue_id);
    return ag ? parseCommissionPct(ag.terms) : null;
  };

  const kioskCountByVenue = new Map<string, number>();
  for (const k of kioskRows) {
    if (!k.venue_id) continue;
    kioskCountByVenue.set(k.venue_id, (kioskCountByVenue.get(k.venue_id) ?? 0) + 1);
  }

  const scenarioFor = (commissionPct: number | null, source: VenueOpportunity["commissionSource"]) => {
    if (networkAvgRentalsPerDay === null || networkAvgTicketCents === null) {
      return {
        scenarioStatus: "insufficient_data" as const,
        scenarioRentalsPerDay: null,
        scenarioDays: SCENARIO_DAYS,
        scenarioGrossCents: null,
        scenarioNetCents: null,
        scenarioNote: "Insufficient network history — no observed rental/payment averages to base an estimate on.",
      };
    }
    const estRentals = networkAvgRentalsPerDay * SCENARIO_DAYS;
    const gross = Math.round(estRentals * networkAvgTicketCents);
    const net = commissionPct !== null ? Math.round(gross * (1 - commissionPct / 100)) : null;
    const note =
      `Estimate only — assumes this venue performs at the observed network average ` +
      `(${networkAvgRentalsPerDay}/day × ${SCENARIO_DAYS} days × avg ticket ${networkAvgTicketCents}¢)` +
      (commissionPct !== null
        ? `, less ${commissionPct}% commission (${source === "agreement" ? "signed agreement" : "network-average assumption"}).`
        : ", no commission rate on file — gross-only figure.");
    return {
      scenarioStatus: "estimate" as const,
      scenarioRentalsPerDay: round1(estRentals),
      scenarioDays: SCENARIO_DAYS,
      scenarioGrossCents: gross,
      scenarioNetCents: net,
      scenarioNote: note,
    };
  };

  const outVenues: VenueOpportunity[] = venues.map((v) => {
    const ownPct = agreementFor(v);
    const pct = ownPct ?? networkAvgCommissionPct;
    const source: VenueOpportunity["commissionSource"] =
      ownPct !== null ? "agreement" : pct !== null ? "network_average" : "none";
    const observed = rentalsByVenue.get(v.id) ?? 0;
    return {
      kind: "venue",
      id: v.id,
      name: v.name,
      city: v.city,
      venueType: v.venue_type,
      organizationId: v.organization_id,
      published: v.published === true,
      kioskCount: kioskCountByVenue.get(v.id) ?? 0,
      observedRentals: observed,
      observedRentalsPerDay: round3(observed / wb.days),
      grossRevenueCents: grossByVenue.get(v.id) ?? 0,
      commissionPct: pct,
      commissionSource: source,
      ...scenarioFor(pct, source),
    };
  });

  const outApps: ApplicationOpportunity[] = applications.map((a) => ({
    kind: "application",
    id: a.id,
    name: a.business_name,
    city: a.city,
    venueType: a.venue_type,
    status: a.status ?? "new",
    createdAt: a.created_at,
    kioskCount: 0,
    observedRentals: 0,
    observedRentalsPerDay: 0,
    grossRevenueCents: 0,
    commissionPct: null,
    scenarioStatus: "insufficient_data",
    scenarioRentalsPerDay: null,
    scenarioDays: SCENARIO_DAYS,
    scenarioGrossCents: null,
    scenarioNetCents: null,
    scenarioNote:
      "Prospective venue — no operating history yet. Scenario estimates are withheld " +
      "rather than invented; revisit once a kiosk is live and producing rental data.",
  }));

  return {
    window: { days: wb.days, start: wb.startDay, end: wb.endDay },
    footTrafficIndex: assumptions.footTrafficIndex,
    networkAvgRentalsPerDay,
    networkAvgTicketCents,
    networkAvgCommissionPct,
    venues: outVenues,
    applications: outApps,
    truncated,
    unavailable,
  };
}
