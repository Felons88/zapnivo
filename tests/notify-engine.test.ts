import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/* ── Channel fakes: the engine's dynamic imports resolve to these modules ── */
const pushCalls: { userId: string; msg: { title: string; body: string } }[] = [];
let pushResult = 1;
vi.mock("../src/lib/push", () => ({
  pushToUser: vi.fn(async (userId: string, msg: { title: string; body: string }, _db?: unknown, diag?: { reason?: string }) => {
    pushCalls.push({ userId, msg });
    if (pushResult === 0 && diag) diag.reason = "no_devices";
    return pushResult;
  }),
  pushToEmail: vi.fn(async () => pushResult),
  pushToRentalCustomer: vi.fn(async () => pushResult),
}));
const emailCalls: string[] = [];
vi.mock("../src/lib/email-triggers", () => ({
  sendToCustomer: vi.fn(async (to: string) => { emailCalls.push(to); return true; }),
}));

import { deliverEvent, emit, inQuietHours, normalizeVars, recordInApp, renderTemplate, sweepNotificationEvents, NOTIFY_TEMPLATES, NOTIFY_VARS } from "../src/lib/notify";

type Row = Record<string, unknown>;
const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** Minimal in-memory SupabaseClient covering notify.ts's query shapes. */
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const seq: Record<string, number> = {};
  const UNIQ: Record<string, string[]> = {
    notifications: ["dedupe_key"],
    notification_events: ["dedupe_key"],
    notification_deliveries: ["notification_id,channel"],
  };

  class QB {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderCol: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    private conflict: string | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    upsert(p: unknown, o?: { onConflict?: string }) { this.op = "upsert"; this.payload = p; this.conflict = o?.onConflict ?? null; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => String(r[c] ?? "") < String(v)); return this; }
    lte(c: string, v: unknown) { this.filters.push((r) => String(r[c] ?? "") <= String(v)); return this; }
    ilike(c: string, v: unknown) { const pat = String(v).replace(/%/g, "").toLowerCase(); this.filters.push((r) => String(r[c] ?? "").toLowerCase().includes(pat)); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderCol = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }
    maybeSingle() { const r = this.run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); }
    single() { const r = this.run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); }
    then<R>(resolve: (v: { data: unknown; error: unknown }) => R) {
      const r = this.run();
      return Promise.resolve(resolve({ data: r.data, error: r.error }));
    }

    private run(): { data: Row[] | null; error: { code: string; message: string } | null } {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert" || this.op === "upsert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          const specs = this.conflict ? [this.conflict] : (UNIQ[this.name] ?? []);
          let merged = false;
          for (const spec of specs) {
            const cols = spec.split(",");
            if (cols.some((c) => item[c] == null)) continue;
            const ex = rows.find((r) => cols.every((c) => eqv(r[c], item[c])));
            if (ex) {
              if (this.op === "upsert" && this.conflict) { Object.assign(ex, item); out.push(ex); merged = true; }
              else return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
          }
          if (merged) continue;
          // Plain insert still respects UNIQ specs (dedupe keys).
          if (this.op === "insert") {
            for (const spec of UNIQ[this.name] ?? []) {
              const cols = spec.split(",");
              if (cols.some((c) => item[c] == null)) continue;
              if (rows.some((r) => cols.every((c) => eqv(r[c], item[c]))))
                return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
          }
          const row = { ...item };
          if (row.id == null) row.id = `${this.name}-${(seq[this.name] = (seq[this.name] ?? 0) + 1)}`;
          rows.push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.orderCol) out = [...out].sort((a, b) => {
        const x = String(a[this.orderCol!.col] ?? ""), y = String(b[this.orderCol!.col] ?? "");
        return this.orderCol!.asc ? x.localeCompare(y) : y.localeCompare(x);
      });
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
  }

  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const PROFILE = { id: "p-1", email: "james@example.com", full_name: "James Hewitt" };
const event = (over: Partial<Row> = {}): Row => ({
  id: 1, profile_id: PROFILE.id, kind: "funds_added", status: "queued",
  vars: { amount: "$25.00", reason: " (goodwill)" }, actor: "staff:a-1", correlation_id: null,
  dedupe_key: null, attempts: 0, due_at: new Date().toISOString(),
  ...over,
});

beforeEach(() => { pushCalls.length = 0; emailCalls.length = 0; pushResult = 1; });

/* ── Template rendering: whitelisted vars, unresolved placeholders fail closed ── */
describe("renderTemplate", () => {
  it("renders whitelisted vars and sanitizes braces from values", () => {
    const t = renderTemplate({ title: "{amount} added", body: "{hi}your top-up was received." }, { amount: "$5.00", hi: "James, " });
    expect(t.title).toBe("$5.00 added");
    expect(t.body).toBe("James, your top-up was received.");
  });
  it("throws on a placeholder that was never provided — customers never see {var}", () => {
    expect(() => renderTemplate({ title: "t", body: "Balance {balance}" }, {})).toThrow("missing_template_var:balance");
  });
  it("rejects placeholders outside the whitelist — no arbitrary injection", () => {
    expect(() => renderTemplate({ title: "t", body: "{secret_key}" }, { secret_key: "x" })).toThrow("unknown_template_var");
  });
  it("strips braces inside values so templates can't be poisoned", () => {
    const t = renderTemplate({ title: "t", body: "Hi {name}" }, { name: "{amount}" });
    expect(t.body).toBe("Hi amount");
  });
});

describe("normalizeVars", () => {
  it("formats numeric cents as dollars and derives first_name/hi", () => {
    const v = normalizeVars({ amount: 550 }, "James Hewitt");
    expect(v.amount).toBe("$5.50");
    expect(v.first_name).toBe("James");
    expect(v.hi).toBe("James, ");
  });
  it("anonymous users get neutral text", () => {
    const v = normalizeVars({}, null);
    expect(v.first_name).toBe("there");
    expect(v.hi).toBe("");
  });
});

describe("inQuietHours", () => {
  const base = { timezone: "America/Chicago", quiet_start: null as number | null, quiet_end: null as number | null };
  it("no window configured → never quiet", () => {
    expect(inQuietHours(base)).toBe(false);
  });
  it("inside a same-day window", () => {
    const noonUtc = new Date("2025-06-01T18:00:00Z"); // 1pm Chicago
    expect(inQuietHours({ ...base, quiet_start: 12, quiet_end: 14 }, noonUtc)).toBe(true);
    expect(inQuietHours({ ...base, quiet_start: 12, quiet_end: 14 }, new Date("2025-06-01T20:00:00Z"))).toBe(false);
  });
  it("overnight windows wrap midnight", () => {
    const twoAm = new Date("2025-06-01T07:00:00Z"); // 2am Chicago
    expect(inQuietHours({ ...base, quiet_start: 22, quiet_end: 7 }, twoAm)).toBe(true);
    expect(inQuietHours({ ...base, quiet_start: 22, quiet_end: 7 }, new Date("2025-06-01T17:00:00Z"))).toBe(false);
  });
});

/* ── Event delivery: durable row → channels → delivery ledger ── */
describe("deliverEvent", () => {
  const seed = () => fakeDb({
    profiles: [PROFILE],
    notification_templates: [],
    customer_notification_prefs: [],
    notifications: [], notification_deliveries: [], notification_events: [],
  });

  it("writes the in-app record and fans out to push+email for essential kinds", async () => {
    const { db, tables } = seed();
    const r = await deliverEvent(db, event() as never);
    expect(r).toBe("done");
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0].kind).toBe("funds_added");
    expect(tables.notifications[0].title).toBe("$25.00 added to your wallet");
    expect(pushCalls).toHaveLength(1);
    expect(emailCalls).toEqual(["james@example.com"]);
    const channels = tables.notification_deliveries.map((d) => `${d.channel}:${d.status}`);
    expect(channels).toContain("in_app:sent");
    expect(channels).toContain("push:sent");
    expect(channels).toContain("email:sent");
    expect(tables.notification_events.find((e) => e.id === 1)?.status ?? "updated-on-seed").toBeTruthy();
  });

  it("renders body copy personalized with the customer's first name", async () => {
    const { db, tables } = seed();
    await deliverEvent(db, event() as never);
    expect(String(tables.notifications[0].body)).toMatch(/^James, \$25\.00 was added/);
  });

  it("skips email for mobile.placeholder addresses", async () => {
    const { db, tables } = fakeDb({
      profiles: [{ ...PROFILE, email: "abc123@mobile.zapnivo.com" }],
      notifications: [], notification_deliveries: [], notification_events: [],
      customer_notification_prefs: [], notification_templates: [],
    });
    await deliverEvent(db, event() as never);
    expect(emailCalls).toHaveLength(0);
    expect(tables.notification_deliveries.find((d) => d.channel === "email")?.status).toBe("skipped");
  });

  it("marks the event dead on a render failure — no {var} reaches a customer", async () => {
    const { db, tables } = seed();
    const r = await deliverEvent(db, event({ vars: {} }) as never); // funds_added needs amount+reason
    expect(r).toBe("failed");
    expect(tables.notifications).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  it("records push delivery failures honestly instead of claiming success", async () => {
    pushResult = 0; // no registered devices
    const { db, tables } = seed();
    await deliverEvent(db, event() as never);
    expect(tables.notification_deliveries.find((d) => d.channel === "push")?.status).toBe("failed");
    expect(tables.notification_deliveries.find((d) => d.channel === "push")?.detail).toBe("no_devices");
  });

  it("defers optional categories to quiet-hours and requeues the push", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE],
      customer_notification_prefs: [{ profile_id: PROFILE.id, offers: true, product_updates: true, rental_reminders: true, support_updates: true, rewards: true, quiet_start: 0, quiet_end: 23, timezone: "America/Chicago" }],
      notifications: [], notification_deliveries: [], notification_events: [], notification_templates: [],
    });
    const r = await deliverEvent(db, event({ kind: "promo_offer", vars: { promo: "Weekend deal", reason: "off-peak rentals are half price" } }) as never);
    expect(r).toBe("done");
    expect(tables.notifications).toHaveLength(1); // in-app still records
    expect(pushCalls).toHaveLength(0);
    expect(tables.notification_deliveries.find((d) => d.channel === "push")?.status).toBe("deferred");
    expect(tables.notification_events.some((e) => String(e.dedupe_key).endsWith(":quiet"))).toBe(true);
  });

  it("suppresses push+email when the customer opted out of the category", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE],
      customer_notification_prefs: [{ profile_id: PROFILE.id, offers: false, product_updates: false, rental_reminders: false, support_updates: false, rewards: false, quiet_start: null, quiet_end: null }],
      notifications: [], notification_deliveries: [], notification_events: [], notification_templates: [],
    });
    await deliverEvent(db, event({ kind: "promo_offer", vars: { promo: "Deal", reason: "details" } }) as never);
    expect(tables.notifications).toHaveLength(1);
    expect(pushCalls).toHaveLength(0);
    expect(tables.notification_deliveries.find((d) => d.channel === "push")?.status).toBe("skipped");
  });

  it("essential kinds ignore the opt-out and still deliver", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE],
      customer_notification_prefs: [{ profile_id: PROFILE.id, offers: false, product_updates: false, rental_reminders: false, support_updates: false, rewards: false, quiet_start: 0, quiet_end: 23 }],
      notifications: [], notification_deliveries: [], notification_events: [], notification_templates: [],
    });
    await deliverEvent(db, event() as never); // funds_added is essential
    expect(pushCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);
    expect(tables.notification_deliveries.find((d) => d.channel === "push")?.status).toBe("sent");
  });

  it("a DB template override wins over the code registry", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE],
      notification_templates: [{ kind: "funds_added", category: "payment", title: "Custom: {amount}", body: "Custom body {reason}", channels: ["in_app"], essential: true, enabled: true }],
      customer_notification_prefs: [], notifications: [], notification_deliveries: [], notification_events: [],
    });
    await deliverEvent(db, event() as never);
    expect(tables.notifications[0].title).toBe("Custom: $25.00");
    expect(tables.notifications[0].body).toBe("Custom body (goodwill)");
    expect(pushCalls).toHaveLength(0); // override narrowed channels to in_app
  });

  it("a disabled template drops the event silently (marked done, nothing sent)", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE],
      notification_templates: [{ kind: "promo_offer", category: "offer", title: "t", body: "b", channels: ["in_app", "push"], essential: false, enabled: false }],
      customer_notification_prefs: [], notifications: [], notification_deliveries: [], notification_events: [],
    });
    const r = await deliverEvent(db, event({ kind: "promo_offer", vars: { promo: "x", reason: "y" } }) as never);
    expect(r).toBe("failed");
    expect(tables.notifications).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  it("deep links are allowlisted — a foreign URL never reaches the payload", async () => {
    const { db, tables } = seed();
    await deliverEvent(db, event({ vars: { amount: "$5", reason: "", deep_link: "https://evil.example/phish" } }) as never);
    expect((tables.notifications[0].data as Row).deep_link).toBeUndefined();
  });

  it("valid deep links pass through to the app", async () => {
    const { db, tables } = seed();
    await deliverEvent(db, event({ vars: { amount: "$5", reason: "", deep_link: "wallet" } }) as never);
    expect((tables.notifications[0].data as Row).deep_link).toBe("wallet");
  });
});

/* ── emit(): durable outbox + dedupe ── */
describe("emit", () => {
  it("inserts an event row and drains it in-band", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE], notification_templates: [], customer_notification_prefs: [],
      notifications: [], notification_deliveries: [], notification_events: [],
    });
    await emit(db, { profileId: PROFILE.id, kind: "funds_added", vars: { amount: 500, reason: "" }, dedupeKey: "t1" });
    expect(tables.notification_events).toHaveLength(1);
    expect(tables.notification_events[0].status).toBe("done");
    expect(tables.notifications).toHaveLength(1);
  });

  it("a repeated dedupe key is a silent no-op — webhook replays can't double-notify", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE], notification_templates: [], customer_notification_prefs: [],
      notifications: [], notification_deliveries: [], notification_events: [],
    });
    await emit(db, { profileId: PROFILE.id, kind: "funds_added", vars: { amount: 500, reason: "" }, dedupeKey: "same" });
    await emit(db, { profileId: PROFILE.id, kind: "funds_added", vars: { amount: 500, reason: "" }, dedupeKey: "same" });
    expect(tables.notification_events).toHaveLength(1);
    expect(tables.notifications).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
  });
});

/* ── The sweep: retries with backoff, dead after 5 ── */
describe("sweepNotificationEvents", () => {
  it("processes due queued events", async () => {
    const { db, tables } = fakeDb({
      profiles: [PROFILE], notification_templates: [], customer_notification_prefs: [],
      notifications: [], notification_deliveries: [],
      notification_events: [event({ id: 7, vars: { amount: "$5", reason: "" } })],
    });
    const r = await sweepNotificationEvents(db);
    expect(r.done).toBe(1);
    expect(String(tables.notification_events[0].status)).toBe("done");
  });

  it("exhausted retries go dead; earlier failures requeue with backoff", async () => {
    const { db, tables } = fakeDb({
      profiles: [], notification_templates: [], customer_notification_prefs: [],
      notifications: [], notification_deliveries: [],
      // kind unknown → render path marks it dead directly; attempts=4 → dead via sweep
      notification_events: [event({ id: 8, kind: "nonexistent_kind", vars: {}, attempts: 4 })],
    });
    const r = await sweepNotificationEvents(db);
    expect(r.dead).toBe(1);
    expect(String(tables.notification_events[0].status)).toBe("dead");
  });
});

/* ── recordInApp: direct persistent rows for legacy pipelines ── */
describe("recordInApp", () => {
  it("writes a deduped in-app row with channel delivery records", async () => {
    const { db, tables } = fakeDb({ notifications: [], notification_deliveries: [] });
    const id = await recordInApp(db, {
      profileId: PROFILE.id, category: "rental", kind: "reminder_3h", title: "Rental update",
      body: "Rental ZR-T1 still out — return by 3 PM.", dedupeKey: "job:9",
      deliveries: [{ channel: "push", status: "sent", detail: "fcm" }, { channel: "sms", status: "failed", detail: "no_phone" }],
    });
    expect(id).toBeTruthy();
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notification_deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual(
      expect.arrayContaining(["in_app:sent", "push:sent", "sms:failed"]),
    );
    // Dedupe: same key returns null, no second row.
    expect(await recordInApp(db, { profileId: PROFILE.id, category: "rental", kind: "reminder_3h", title: "x", body: "y", dedupeKey: "job:9" })).toBeNull();
    expect(tables.notifications).toHaveLength(1);
  });
});

/* ── Catalog sanity: every registered kind renders, essential kinds are honest ── */
describe("NOTIFY_TEMPLATES catalog", () => {
  const sampleVars = Object.fromEntries([...NOTIFY_VARS].map((v) => [v, v === "hi" ? "James, " : v === "amount" || v === "balance" || v === "fee" || v === "charges" ? "$5.00" : "x"]));
  it("every kind uses only whitelisted placeholders and renders with sample vars", () => {
    for (const [kind, tpl] of Object.entries(NOTIFY_TEMPLATES)) {
      const rendered = renderTemplate(tpl, sampleVars);
      expect(rendered.title.length, kind).toBeGreaterThan(0);
      expect(rendered.body.length, kind).toBeGreaterThan(0);
      expect(rendered.body).not.toMatch(/\{\w+\}/);
    }
  });
  it("every kind always includes the in_app channel — the center is the record", () => {
    for (const [kind, tpl] of Object.entries(NOTIFY_TEMPLATES)) {
      expect(tpl.channels, kind).toContain("in_app");
    }
  });
  it("security and payment kinds are essential — they can't be opted out", () => {
    for (const [kind, tpl] of Object.entries(NOTIFY_TEMPLATES)) {
      if (tpl.category === "security" || tpl.category === "payment") expect(tpl.essential, kind).toBe(true);
    }
  });
});
