import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin BI helpers for /admin/analytics — Phase 5.
 *
 * Every figure is computed from real tables and every section names its source:
 *   - analytics_cohorts  → cohort retention snapshot
 *   - rentals + payments + kiosks + venues → station revenue/utilization leaderboard
 *   - business_events    → full browse→rent→feedback funnel (passed in by the page)
 *   - rental_exceptions + support_tickets → weekly incident/support trend
 *
 * A failed query yields `null` for that section (rendered as "—"), never a
 * fabricated number. Pure compute functions are exported for unit tests.
 */

const DAY = 24 * 3600_000;

/* ── Types ─────────────────────────────────────────────────────────────────── */

export type CohortRow = {
  cohort_date: string; // YYYY-MM-DD, first-seen day per subject
  subject: string;     // actor_id or session_ref — never email/phone
  first_event: string;
  days_active: number;
  last_seen: string;   // YYYY-MM-DD
};

export type CohortWeek = {
  weekStart: string;        // Monday of the cohort week, YYYY-MM-DD
  subjects: number;
  /** % of subjects still active ≥7 days after first seen. Null until the cohort matures. */
  week2Pct: number | null;
  /** % of subjects still active ≥28 days after first seen. Null until the cohort matures. */
  week4Pct: number | null;
  matured2: number;         // subjects whose cohort is old enough for the week-2 metric
  matured4: number;
  avgDaysActive: number;
};

export type RentalInsightRow = { id: string; kiosk_id: string | null; state: string; created_at: string };
export type PaymentInsightRow = { rental_id: string; state: string; amount_captured_cents: number | null; amount_refunded_cents: number | null };
export type KioskInsightRow = { id: string; station_id: string; venue_id: string | null };
export type VenueInsightRow = { id: string; name: string };

export type StationRow = {
  station: string;          // kiosk.station_id (QR label)
  venue: string | null;     // venues.name when resolvable
  rentals: number;
  grossCents: number;       // captured − refunded across the station's payments
  returned: number;         // rentals reaching state 'returned'
  completionPct: number | null; // returned / rentals
  bottomDecile: boolean;    // flagged among the lowest-gross stations (only when ≥5 stations have rentals)
};

export type WeeklyBucket = { week: string; count: number }; // week = Monday YYYY-MM-DD
export type FunnelStep = { name: string; label: string; count: number; convPct: number | null };

export type AdminInsights = {
  cohorts: CohortWeek[] | null;            // source: analytics_cohorts
  stations: StationRow[] | null;           // source: rentals ⋈ payments ⋈ kiosks ⋈ venues
  exceptionsWeekly: WeeklyBucket[] | null; // source: rental_exceptions.created_at
  ticketsWeekly: WeeklyBucket[] | null;    // source: support_tickets.created_at
  openExceptions: number | null;           // source: rental_exceptions where status not resolved/dismissed
  openTickets: number | null;              // source: support_tickets where state not resolved/closed
  funnel: FunnelStep[] | null;             // source: business_events (page's 30-day window)
};

/* ── Pure computations ─────────────────────────────────────────────────────── */

const DAY_MS = DAY;
const dstr = (t: number) => new Date(t).toISOString().slice(0, 10);
const parseDay = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);

/** ISO week (Monday) start for a YYYY-MM-DD date. */
export function weekStartOf(dateStr: string): string {
  const t = parseDay(dateStr);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Mon=0
  return dstr(t - dow * DAY_MS);
}

/**
 * Cohort retention snapshot from analytics_cohorts rows.
 * "Active in week N" = last_seen ≥ cohort_date + 7·(N−1)… we use the stricter,
 * honest definition: still seen at least 7 (week 2) / 28 (week 4) days after
 * first seen. Only matured cohorts enter each denominator; immature weeks show
 * null percentages rather than inflated early numbers.
 */
export function cohortSnapshot(rows: CohortRow[], now: Date = new Date()): CohortWeek[] {
  const today = dstr(now.getTime());
  const groups = new Map<string, CohortRow[]>();
  for (const r of rows) {
    const wk = weekStartOf(r.cohort_date);
    const g = groups.get(wk) ?? [];
    g.push(r);
    groups.set(wk, g);
  }
  const out: CohortWeek[] = [];
  for (const [weekStart, members] of [...groups.entries()].sort()) {
    let matured2 = 0, ret2 = 0, matured4 = 0, ret4 = 0, daysSum = 0;
    for (const m of members) {
      daysSum += m.days_active;
      const ageDays = Math.floor((parseDay(today) - parseDay(m.cohort_date)) / DAY_MS);
      if (ageDays >= 7) {
        matured2 += 1;
        if (parseDay(m.last_seen) >= parseDay(m.cohort_date) + 7 * DAY_MS) ret2 += 1;
      }
      if (ageDays >= 28) {
        matured4 += 1;
        if (parseDay(m.last_seen) >= parseDay(m.cohort_date) + 28 * DAY_MS) ret4 += 1;
      }
    }
    out.push({
      weekStart,
      subjects: members.length,
      week2Pct: matured2 > 0 ? Math.round((ret2 / matured2) * 1000) / 10 : null,
      week4Pct: matured4 > 0 ? Math.round((ret4 / matured4) * 1000) / 10 : null,
      matured2,
      matured4,
      avgDaysActive: members.length ? Math.round((daysSum / members.length) * 10) / 10 : 0,
    });
  }
  return out;
}

/**
 * Per-station rental count + gross revenue leaderboard.
 * rentals.kiosk_id → kiosks.id → station_id/venue_id → venues.name.
 * Gross = Σ amount_captured_cents − Σ amount_refunded_cents over payments whose
 * state is 'captured' or 'partially_refunded' (money actually kept).
 * Bottom decile is only flagged when ≥5 stations have rentals — with fewer the
 * "decile" would be noise.
 */
export function stationLeaderboard(input: {
  rentals: RentalInsightRow[];
  payments: PaymentInsightRow[];
  kiosks: KioskInsightRow[];
  venues: VenueInsightRow[];
}): StationRow[] {
  const kioskById = new Map(input.kiosks.map((k) => [k.id, k]));
  const venueById = new Map(input.venues.map((v) => [v.id, v.name]));
  const grossByRental = new Map<string, number>();
  for (const p of input.payments) {
    if (p.state !== "captured" && p.state !== "partially_refunded") continue;
    const net = (p.amount_captured_cents ?? 0) - (p.amount_refunded_cents ?? 0);
    grossByRental.set(p.rental_id, (grossByRental.get(p.rental_id) ?? 0) + net);
  }
  const byStation = new Map<string, { venueId: string | null; rentals: number; grossCents: number; returned: number }>();
  for (const r of input.rentals) {
    const kiosk = r.kiosk_id ? kioskById.get(r.kiosk_id) : undefined;
    const station = kiosk?.station_id ?? "unknown";
    const cur = byStation.get(station) ?? { venueId: kiosk?.venue_id ?? null, rentals: 0, grossCents: 0, returned: 0 };
    cur.rentals += 1;
    cur.grossCents += grossByRental.get(r.id) ?? 0;
    if (r.state === "returned") cur.returned += 1;
    byStation.set(station, cur);
  }
  const rows: StationRow[] = [...byStation.entries()].map(([station, s]) => ({
    station,
    venue: s.venueId ? venueById.get(s.venueId) ?? null : null,
    rentals: s.rentals,
    grossCents: s.grossCents,
    returned: s.returned,
    completionPct: s.rentals > 0 ? Math.round((s.returned / s.rentals) * 1000) / 10 : null,
    bottomDecile: false,
  }));
  rows.sort((a, b) => b.grossCents - a.grossCents || b.rentals - a.rentals);
  // Flag the lowest-gross decile among stations that actually had rentals.
  if (rows.length >= 5) {
    const flagged = Math.max(1, Math.floor(rows.length * 0.1));
    const tail = [...rows].sort((a, b) => a.grossCents - b.grossCents).slice(0, flagged);
    const ids = new Set(tail.map((t) => t.station));
    for (const r of rows) r.bottomDecile = ids.has(r.station);
  }
  return rows;
}

/** Bucket timestamped rows into ISO weeks (Monday). Sorted ascending. */
export function weeklyCounts(rows: { created_at: string }[]): WeeklyBucket[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const wk = weekStartOf(r.created_at.slice(0, 10));
    m.set(wk, (m.get(wk) ?? 0) + 1);
  }
  return [...m.entries()].sort().map(([week, count]) => ({ week, count }));
}

/**
 * Full customer journey funnel from a name→count map (business_events).
 * There is no dedicated "review" event in the pipeline — the honest terminal
 * step is customer_feedback_submitted (labelled as such).
 */
export const JOURNEY_FUNNEL: { name: string; label: string }[] = [
  { name: "page_view", label: "Page views" },
  { name: "rental_qr_opened", label: "QR scans" },
  { name: "rental_checkout_started", label: "Checkouts started" },
  { name: "rental_started", label: "Rentals started" },
  { name: "rental_completed", label: "Rentals completed" },
  { name: "customer_feedback_submitted", label: "Feedback submitted" },
];

export function journeyFunnel(byName: Map<string, number>): FunnelStep[] {
  return JOURNEY_FUNNEL.map((f, i) => {
    const count = byName.get(f.name) ?? 0;
    const prev = i === 0 ? null : byName.get(JOURNEY_FUNNEL[i - 1].name) ?? 0;
    return { name: f.name, label: f.label, count, convPct: prev && prev > 0 ? Math.round((count / prev) * 1000) / 10 : null };
  });
}

/* ── Loader (service-role; server-only callers) ────────────────────────────── */

async function safe<T>(q: PromiseLike<unknown>): Promise<T[] | null> {
  try {
    const { data, error } = (await q) as { data: T[] | null; error: { message?: string } | null };
    return error ? null : (data ?? []);
  } catch {
    return null;
  }
}

/**
 * Loads every insights section. Pass the page's already-fetched business_events
 * window for the funnel so we don't scan the table twice. Each section degrades
 * to null independently.
 */
export async function loadAdminInsights(
  db: SupabaseClient,
  events: { name: string }[],
): Promise<AdminInsights> {
  const [cohortRows, rentals, payments, kiosks, venues, exceptions, tickets] = await Promise.all([
    safe<CohortRow>(db.from("analytics_cohorts").select("cohort_date,subject,first_event,days_active,last_seen").limit(50000)),
    safe<RentalInsightRow>(db.from("rentals").select("id,kiosk_id,state,created_at").limit(50000)),
    safe<PaymentInsightRow>(db.from("payments").select("rental_id,state,amount_captured_cents,amount_refunded_cents").limit(50000)),
    safe<KioskInsightRow>(db.from("kiosks").select("id,station_id,venue_id").limit(5000)),
    safe<VenueInsightRow>(db.from("venues").select("id,name").limit(5000)),
    safe<{ created_at: string; status: string }>(db.from("rental_exceptions").select("created_at,status").limit(50000)),
    safe<{ created_at: string; state: string }>(db.from("support_tickets").select("created_at,state").limit(50000)),
  ]);

  const byName = new Map<string, number>();
  for (const e of events) byName.set(e.name, (byName.get(e.name) ?? 0) + 1);

  const stations = rentals && payments && kiosks && venues
    ? stationLeaderboard({ rentals, payments, kiosks, venues })
    : null;

  return {
    cohorts: cohortRows ? cohortSnapshot(cohortRows) : null,
    stations,
    exceptionsWeekly: exceptions ? weeklyCounts(exceptions) : null,
    ticketsWeekly: tickets ? weeklyCounts(tickets) : null,
    openExceptions: exceptions == null ? null : exceptions.filter((e) => !["resolved", "dismissed"].includes(e.status)).length,
    openTickets: tickets == null ? null : tickets.filter((t) => !["resolved", "closed"].includes(t.state)).length,
    funnel: journeyFunnel(byName),
  };
}
