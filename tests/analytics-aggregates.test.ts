import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability", () => ({ recordLog: vi.fn() }));

import { aggregateDay } from "@/lib/analytics-aggregates";

/** Minimal fake Supabase client for business_events select + analytics writes. */
function fakeDb(events: Record<string, unknown>[]) {
  const inserted: Record<string, unknown>[] = [];
  const upserted: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => {
      if (table === "business_events") {
        return {
          select: () => ({
            gte: () => ({ lt: () => ({ range: async () => ({ data: events, error: null }) }) }),
          }),
        };
      }
      if (table === "analytics_daily") {
        return {
          delete: () => ({ eq: async () => ({ error: null }) }),
          insert: async (rows: Record<string, unknown>[]) => { inserted.push(...rows); return { error: null }; },
        };
      }
      if (table === "analytics_cohorts") {
        return {
          select: () => ({ in: async () => ({ data: [], error: null }) }),
          upsert: async (rows: Record<string, unknown>[]) => { upserted.push(...rows); return { error: null }; },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: db as never, inserted, upserted };
}

const ev = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  occurred_at: "2025-01-10T12:00:00Z",
  actor_id: null,
  session_ref: "sess1",
  props: {},
  ...extra,
});

describe("aggregateDay", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts events per name+dimension with unique subjects", async () => {
    const { db, inserted } = fakeDb([
      ev("page_view", { props: { source: "google" } }),
      ev("page_view", { props: { source: "google" }, session_ref: "sess2" }),
      ev("page_view"),
      ev("rental_started", { actor_id: "u1", props: { source: "partner" } }),
    ]);
    const r = await aggregateDay(db, new Date("2025-01-10T00:00:00Z"));
    expect(r.events).toBe(4);
    const pv = inserted.filter((i) => i.event_type === "page_view");
    expect(pv).toHaveLength(2); // source=google and ''
    const google = pv.find((i) => i.dimension === "source=google")!;
    expect(google.count).toBe(2);
    expect(google.unique_users).toBe(2);
    const plain = pv.find((i) => i.dimension === "")!;
    expect(plain.count).toBe(1);
    expect(inserted.find((i) => i.event_type === "rental_started")?.dimension).toBe("source=partner");
  });

  it("builds cohort rows keyed by subject with first event", async () => {
    const { db, upserted } = fakeDb([
      ev("page_view", { session_ref: "a" }),
      ev("partner_application_submitted", { session_ref: "a" }),
      ev("page_view", { session_ref: "b" }),
    ]);
    await aggregateDay(db, new Date("2025-01-10T00:00:00Z"));
    expect(upserted).toHaveLength(2);
    const a = upserted.find((u) => u.subject === "a")!;
    expect(a.first_event).toBe("page_view");
    expect(a.cohort_date).toBe("2025-01-10");
  });

  it("never stores raw email/phone — only actor_id/session_ref subjects", async () => {
    const { db, upserted } = fakeDb([ev("page_view", { props: { email: "x@y.z" } })]);
    await aggregateDay(db, new Date("2025-01-10T00:00:00Z"));
    for (const row of upserted) {
      expect(JSON.stringify(row)).not.toContain("x@y.z");
    }
  });
});
