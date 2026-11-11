import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "./observability";

/**
 * Daily rollup of business_events into analytics_daily + analytics_cohorts.
 * Idempotent per (day, event_type, dimension): re-running a day overwrites counts.
 * Dimensions are pulled only from an allowlist of scalar props — never raw PII.
 */

const DIMENSION_PROPS = ["source", "variant", "page", "placement", "category"] as const;

type EventRow = {
  name: string;
  occurred_at: string;
  actor_id: string | null;
  session_ref: string | null;
  props: Record<string, unknown> | null;
};

function subjectOf(e: EventRow): string | null {
  return e.actor_id ?? e.session_ref ?? null;
}

function dimensionOf(e: EventRow): string {
  const p = e.props ?? {};
  for (const k of DIMENSION_PROPS) {
    const v = p[k];
    if (typeof v === "string" && v.length <= 64) return `${k}=${v}`;
  }
  return "";
}

/** Aggregate one UTC day of events. Returns rows written. */
export async function aggregateDay(db: SupabaseClient, day: Date): Promise<{ events: number; dailyRows: number; cohortRows: number }> {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 3600_000);
  const dayStr = start.toISOString().slice(0, 10);

  // Fetch the day's events (paged — a busy day could exceed a single page).
  const events: EventRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("business_events")
      .select("name,occurred_at,actor_id,session_ref,props")
      .gte("occurred_at", start.toISOString())
      .lt("occurred_at", end.toISOString())
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`events_fetch:${error.message}`);
    events.push(...((data ?? []) as EventRow[]));
    if (!data || data.length < PAGE) break;
  }

  // Replace this day's rollups (idempotent re-run).
  await db.from("analytics_daily").delete().eq("day", dayStr);

  const daily = new Map<string, { count: number; subjects: Set<string> }>();
  const cohorts = new Map<string, { first: string; last: string; days: Set<string>; firstEvent: string }>();

  for (const e of events) {
    const dim = dimensionOf(e);
    const key = `${e.name}|${dim}`;
    const d = daily.get(key) ?? { count: 0, subjects: new Set<string>() };
    d.count += 1;
    const s = subjectOf(e);
    if (s) d.subjects.add(s);
    daily.set(key, d);

    if (s) {
      const c = cohorts.get(s) ?? { first: e.occurred_at, last: e.occurred_at, days: new Set<string>([dayStr]), firstEvent: e.name };
      if (e.occurred_at < c.first) { c.first = e.occurred_at; c.firstEvent = e.name; }
      if (e.occurred_at > c.last) c.last = e.occurred_at;
      c.days.add(dayStr);
      cohorts.set(s, c);
    }
  }

  if (daily.size) {
    const rows = [...daily.entries()].map(([key, v]) => {
      const [event_type, ...rest] = key.split("|");
      return { day: dayStr, event_type, dimension: rest.join(""), count: v.count, unique_users: v.subjects.size };
    });
    const { error } = await db.from("analytics_daily").insert(rows);
    if (error) throw new Error(`daily_insert:${error.message}`);
  }

  if (cohorts.size) {
    // Merge with existing cohort rows for these subjects (they may span days).
    const subjects = [...cohorts.keys()];
    const { data: existing } = await db
      .from("analytics_cohorts")
      .select("subject,cohort_date,first_event,last_seen")
      .in("subject", subjects);
    const bySubject = new Map<string, { cohort_date: string; first_event: string; last_seen: string }>();
    for (const r of (existing ?? []) as { subject: string; cohort_date: string; first_event: string; last_seen: string }[]) {
      const cur = bySubject.get(r.subject);
      if (!cur || r.cohort_date < cur.cohort_date) bySubject.set(r.subject, r);
    }
    const cohortRows = [...cohorts.entries()].map(([subject, c]) => {
      const prev = bySubject.get(subject);
      const cohortDate = prev?.cohort_date ?? c.first.slice(0, 10);
      const lastSeen = c.last.slice(0, 10) > (prev?.last_seen ?? "") ? c.last.slice(0, 10) : (prev?.last_seen ?? c.last.slice(0, 10));
      return {
        cohort_date: cohortDate,
        subject,
        first_event: prev?.first_event ?? c.firstEvent,
        days_active: c.days.size + (prev ? 1 : 0), // prev days counted conservatively
        last_seen: lastSeen,
      };
    });
    // Upsert on (cohort_date, subject) — new cohort rows for new subjects.
    const { error } = await db.from("analytics_cohorts").upsert(cohortRows, { onConflict: "cohort_date,subject" });
    if (error) throw new Error(`cohort_upsert:${error.message}`);
  }

  recordLog("info", "analytics_aggregate_day", { service: "analytics", attrs: { day: dayStr, events: events.length, daily_rows: daily.size, cohort_rows: cohorts.size } });
  return { events: events.length, dailyRows: daily.size, cohortRows: cohorts.size };
}

/** Aggregate the last `days` complete UTC days plus today-so-far on request. */
export async function runAggregation(db: SupabaseClient, days = 2): Promise<{ day: string; events: number }[]> {
  const out: { day: string; events: number }[] = [];
  for (let i = days; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600_000);
    const r = await aggregateDay(db, d);
    out.push({ day: d.toISOString().slice(0, 10), events: r.events });
  }
  return out;
}
