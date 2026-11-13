import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown> & { id?: string };

const { dbHolder, repoHolder, mailerHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  repoHolder: { repo: null as unknown, queued: [] as Record<string, unknown>[] },
  mailerHolder: { mailer: { send: vi.fn(async () => {}) } as unknown },
}));

function createFakeDb() {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const st = {
      op: "select" as "select" | "insert" | "update",
      filters: [] as [string, unknown][],
      payload: null as unknown,
      want: "many" as "many" | "single" | "maybe",
      limitN: Number.POSITIVE_INFINITY,
    };
    const match = (r: Row) => st.filters.every(([c, v]) => r[c] === v);
    const exec = () => {
      if (st.op === "insert") {
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...(st.payload as Row) };
        rows.push(row);
        return { data: st.want === "many" ? [row] : row, error: null };
      }
      if (st.op === "update") {
        const matched = rows.filter(match);
        for (const r of matched) Object.assign(r, st.payload as Row);
        return { data: st.want === "many" ? matched : matched[0] ?? null, error: null };
      }
      let out = rows.filter(match);
      if (st.limitN !== Number.POSITIVE_INFINITY) out = out.slice(0, st.limitN);
      return { data: st.want === "many" ? out : out[0] ?? null, error: null };
    };
    const b = {
      select: () => { if (st.op === "select") st.want = "many"; return b; },
      insert: (p: unknown) => { st.op = "insert"; st.payload = p; return b; },
      update: (p: unknown) => { st.op = "update"; st.payload = p; return b; },
      eq: (c: string, v: unknown) => { st.filters.push([c, v]); return b; },
      order: () => b,
      limit: (n: number) => { st.limitN = n; return b; },
      single: async () => { st.want = "single"; return exec(); },
      maybeSingle: async () => { st.want = "maybe"; return exec(); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  };
  return {
    from,
    _tables: tables,
    rows: (t: string) => tables[t] ?? [],
  };
}

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbHolder.db,
  backendConfigured: () => true,
}));

vi.mock("@/lib/helpdesk/repo", () => ({
  getRepo: async () => repoHolder.repo,
}));

vi.mock("@/lib/helpdesk/mailer", () => ({
  getMailer: () => mailerHolder.mailer,
  flushOutbox: async (_repo: unknown, _mailer: unknown) => ({
    sent: repoHolder.queued.length, failed: 0, queued: 0,
    sentIds: repoHolder.queued.map((q) => q.id as string), failedIds: [],
  }),
}));

const logCalls: { level: string; message: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("@/lib/observability", () => ({
  recordLog: (level: string, message: string, ctx?: { attrs?: Record<string, unknown> }) => {
    logCalls.push({ level, message, attrs: ctx?.attrs });
  },
  reportError: vi.fn(),
}));

import { POST as subscribePost } from "@/app/api/newsletter/subscribe/route";
import {
  newsletterSubscribeSchema,
  decideSubscribe,
  mergeSegments,
  newsletterConfigFromContent,
  isExcludedRoute,
  DEFAULT_NEWSLETTER_CONFIG,
  NEWSLETTER_CONSENT_VERSION,
} from "@/lib/newsletter/core";
import {
  subscribe, confirmSubscription, unsubscribeSubscription,
  resendConfirmation, getNewsletterOverview, hashToken, syncBrevoAudience,
} from "@/lib/newsletter/service";

/* ── Setup ─────────────────────────────────────────────────────────────────── */

let fake: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  fake = createFakeDb();
  dbHolder.db = fake;
  repoHolder.queued = [];
  repoHolder.repo = {
    queueEmail: async (e: Record<string, unknown>) => {
      const row = { id: `em-${repoHolder.queued.length + 1}`, createdAt: new Date().toISOString(), status: "queued", ...e };
      repoHolder.queued.push(row);
      return row;
    },
  };
  logCalls.length = 0;
  delete process.env.BREVO_API_KEY;
  delete process.env.NEWSLETTER_BREVO_LIST_ID;
  delete process.env.RESEND_API_KEY;
  vi.unstubAllGlobals();
});

afterEach(() => vi.unstubAllGlobals());

const sub = (email: string, segment: "customer" | "business" = "customer") =>
  subscribe({ email, segment, consent: true, source: "website_popup", website: undefined });

const tokenFromEmail = (i = 0): string => {
  const html = String(repoHolder.queued[i]?.html ?? "");
  const m = html.match(/\/api\/newsletter\/confirm\?token=([A-Za-z0-9_\-]+)/);
  expect(m, "confirm link present in DOI email").toBeTruthy();
  return decodeURIComponent(m![1]);
};

const unsubTokenFromEmail = (i = 0): string => {
  const html = String(repoHolder.queued[i]?.html ?? "");
  const m = html.match(/\/api\/newsletter\/unsubscribe\?token=([A-Za-z0-9_\-]+)/);
  expect(m, "unsubscribe link present").toBeTruthy();
  return decodeURIComponent(m![1]);
};

/* ── Schema ────────────────────────────────────────────────────────────────── */

describe("newsletterSubscribeSchema", () => {
  it("accepts a valid customer signup", () => {
    const r = newsletterSubscribeSchema.safeParse({ email: " A@B.com ", segment: "customer", consent: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("a@b.com");
  });
  it("rejects bad email, missing consent, bad segment, honeypot fill", () => {
    expect(newsletterSubscribeSchema.safeParse({ email: "nope", segment: "customer", consent: true }).success).toBe(false);
    expect(newsletterSubscribeSchema.safeParse({ email: "a@b.com", segment: "customer" }).success).toBe(false);
    expect(newsletterSubscribeSchema.safeParse({ email: "a@b.com", segment: "customer", consent: false }).success).toBe(false);
    expect(newsletterSubscribeSchema.safeParse({ email: "a@b.com", segment: "both", consent: true }).success).toBe(false);
    expect(newsletterSubscribeSchema.safeParse({ email: "a@b.com", segment: "customer", consent: true, website: "x" }).success).toBe(false);
  });
});

/* ── Pure logic ────────────────────────────────────────────────────────────── */

describe("decideSubscribe / mergeSegments", () => {
  it("merges customer+business to both", () => {
    expect(mergeSegments("customer", "business")).toBe("both");
    expect(mergeSegments("business", "customer")).toBe("both");
    expect(mergeSegments("both", "customer")).toBe("both");
    expect(mergeSegments("customer", "customer")).toBe("customer");
  });
  it("dedup matrix", () => {
    expect(decideSubscribe(null, "customer")).toEqual({ action: "create", segment: "customer" });
    expect(decideSubscribe({ status: "pending", segment: "customer" }, "business")).toEqual({ action: "resend_pending", segment: "both" });
    expect(decideSubscribe({ status: "confirmed", segment: "customer" }, "business")).toEqual({ action: "merge_confirmed", segment: "both" });
    expect(decideSubscribe({ status: "unsubscribed", segment: "business" }, "customer")).toEqual({ action: "resubscribe", segment: "both" });
  });
});

describe("popup config", () => {
  it("defaults match spec when CMS is empty", () => {
    const c = newsletterConfigFromContent({});
    expect(c).toEqual(DEFAULT_NEWSLETTER_CONFIG);
    expect(c.headline).toBe("Never Run Out of Power.");
    expect(c.enabled).toBe(true);
    expect(c.frequencyCapDays).toBe(14);
  });
  it("CMS overrides win and are sanitized", () => {
    const c = newsletterConfigFromContent({
      enabled: false,
      headline: "Custom headline",
      delay_seconds: "30",
      frequency_cap_days: "7",
      excluded_routes: "/checkout, /account ,",
      business_cta_href: "/business/apply",
    });
    expect(c.enabled).toBe(false);
    expect(c.headline).toBe("Custom headline");
    expect(c.delaySeconds).toBe(30);
    expect(c.frequencyCapDays).toBe(7);
    expect(c.excludedRoutes).toEqual(["/checkout", "/account"]);
    expect(c.businessCtaHref).toBe("/business/apply");
  });
  it("clamps out-of-range numbers to defaults", () => {
    const c = newsletterConfigFromContent({ delay_seconds: "9999", frequency_cap_days: "0" });
    expect(c.delaySeconds).toBe(120);
    expect(c.frequencyCapDays).toBe(1);
  });
});

describe("isExcludedRoute", () => {
  it("matches on segment boundaries only", () => {
    const ex = DEFAULT_NEWSLETTER_CONFIG.excludedRoutes;
    expect(isExcludedRoute("/account", ex)).toBe(true);
    expect(isExcludedRoute("/account/gifts", ex)).toBe(true);
    expect(isExcludedRoute("/login", ex)).toBe(true);
    expect(isExcludedRoute("/r/ABC123", ex)).toBe(true);
    expect(isExcludedRoute("/", ex)).toBe(false);
    expect(isExcludedRoute("/how-it-works", ex)).toBe(false);
    expect(isExcludedRoute("/accounting-tips", ex)).toBe(false); // no false prefix match
    expect(isExcludedRoute("/locations?x=1", ex)).toBe(false);
  });
});

/* ── DOI pipeline ──────────────────────────────────────────────────────────── */

describe("subscribe → confirm → unsubscribe", () => {
  it("creates a pending row, stores only token hashes, and queues a DOI email", async () => {
    const res = await sub("New@Example.com", "customer");
    expect(res).toEqual({ ok: true, action: "created" });

    const rows = fake.rows("newsletter_subscribers");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.email).toBe("new@example.com");
    expect(row.status).toBe("pending");
    expect(row.segment).toBe("customer");
    expect(row.consent_text_version).toBe(NEWSLETTER_CONSENT_VERSION);
    expect(row.consent_at).toBeTruthy();
    // Raw tokens never touch the DB — only SHA-256 hashes.
    const confirmTok = tokenFromEmail();
    expect(row.confirm_token_hash).toBe(hashToken(confirmTok));
    expect(row.confirm_token_hash).not.toBe(confirmTok);
    expect(String(row.confirm_token_hash)).toMatch(/^[0-9a-f]{64}$/);
    // Analytics event recorded (server-side, no PII props).
    const ev = fake.rows("business_events").find((r) => r.name === "newsletter_subscribed");
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev!.props)).not.toContain("new@example.com");
  });

  it("pending re-subscribe rotates tokens and resends DOI", async () => {
    await sub("a@b.com");
    const firstHash = fake.rows("newsletter_subscribers")[0].confirm_token_hash;
    const res = await sub("a@b.com", "business");
    expect(res).toEqual({ ok: true, action: "resent" });
    const row = fake.rows("newsletter_subscribers")[0];
    expect(row.status).toBe("pending");
    expect(row.segment).toBe("both"); // customer + business merged
    expect(row.confirm_token_hash).not.toBe(firstHash);
    expect(repoHolder.queued).toHaveLength(2);
    // Business interest → partner lead in the staff intake queue.
    const lead = fake.rows("contact_messages").find((r) => r.queue === "venue_partnerships");
    expect(lead).toBeTruthy();
    expect(String(lead!.email)).toBe("a@b.com");
  });

  it("confirm flips pending → confirmed, is idempotent, and sends welcome email", async () => {
    await sub("c@d.com");
    const token = tokenFromEmail();
    const r1 = await confirmSubscription(token);
    expect(r1).toEqual({ ok: true, status: "confirmed" });
    const row = fake.rows("newsletter_subscribers")[0];
    expect(row.status).toBe("confirmed");
    expect(row.confirmed_at).toBeTruthy();
    // Welcome email (index 1) carries a fresh unsubscribe token.
    expect(repoHolder.queued).toHaveLength(2);
    const r2 = await confirmSubscription(token);
    expect(r2).toEqual({ ok: true, status: "already_confirmed" });
    // Bad token → honest 404.
    expect(await confirmSubscription("x".repeat(40))).toMatchObject({ ok: false, status: 404 });
  });

  it("confirmed re-subscribe merges segment with NO new DOI email", async () => {
    await sub("e@f.com", "customer");
    await confirmSubscription(tokenFromEmail());
    const queuedBefore = repoHolder.queued.length;
    const res = await sub("e@f.com", "business");
    expect(res).toEqual({ ok: true, action: "updated" });
    const row = fake.rows("newsletter_subscribers")[0];
    expect(row.status).toBe("confirmed");
    expect(row.segment).toBe("both");
    expect(repoHolder.queued).toHaveLength(queuedBefore); // no DOI for confirmed merge
    // New business interest created a partner lead.
    expect(fake.rows("contact_messages").some((r) => r.queue === "venue_partnerships")).toBe(true);
  });

  it("unsubscribe burns tokens; resubscribe starts a fresh pending cycle", async () => {
    await sub("g@h.com", "customer");
    await confirmSubscription(tokenFromEmail());
    const unsub = unsubTokenFromEmail(1); // welcome email
    const u = await unsubscribeSubscription(unsub);
    expect(u).toEqual({ ok: true });
    const row = fake.rows("newsletter_subscribers")[0];
    expect(row.status).toBe("unsubscribed");
    expect(row.unsubscribed_at).toBeTruthy();
    expect(row.confirm_token_hash).toBeNull();
    expect(row.unsubscribe_token_hash).toBeNull();
    // Token is dead — repeat unsubscribe 404s.
    expect(await unsubscribeSubscription(unsub)).toMatchObject({ ok: false, status: 404 });
    // Explicit re-submit → new pending cycle + fresh DOI.
    const res = await sub("g@h.com", "customer");
    expect(res).toEqual({ ok: true, action: "resubscribed" });
    const row2 = fake.rows("newsletter_subscribers")[0];
    expect(row2.status).toBe("pending");
    expect(row2.confirm_token_hash).toBeTruthy();
  });

  it("unsubscribed row cannot be resurrected by an old confirm token", async () => {
    await sub("i@j.com");
    const confirmTok = tokenFromEmail();
    await unsubscribeSubscription(unsubTokenFromEmail(0)); // DOI email also has unsub link
    // Old confirm token was burned with the unsubscribe → 404.
    expect(await confirmSubscription(confirmTok)).toMatchObject({ ok: false });
  });
});

/* ── Failure honesty ───────────────────────────────────────────────────────── */

describe("failure honesty", () => {
  it("no backend → 503, nothing written", async () => {
    dbHolder.db = null;
    const res = await sub("x@y.com");
    expect(res).toMatchObject({ ok: false, status: 503 });
  });

  it("Brevo sync failure never blocks confirmation; not-configured is honest", async () => {
    expect(await syncBrevoAudience("a@b.com", "customer", "confirmed")).toEqual({ synced: false, reason: "not_configured" });
    process.env.BREVO_API_KEY = "test-key";
    process.env.NEWSLETTER_BREVO_LIST_ID = "42";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await syncBrevoAudience("a@b.com", "customer", "confirmed");
    expect(r).toEqual({ synced: false, reason: "provider_error" });
    // And confirm still succeeds end-to-end.
    await sub("k@l.com");
    const c = await confirmSubscription(tokenFromEmail());
    expect(c).toEqual({ ok: true, status: "confirmed" });
  });

  it("no PII (email) appears in any log call", async () => {
    await sub("pii-check@example.com", "business");
    await confirmSubscription(tokenFromEmail());
    for (const c of logCalls) {
      expect(JSON.stringify(c.attrs ?? {})).not.toContain("pii-check@example.com");
    }
  });
});

/* ── Admin ─────────────────────────────────────────────────────────────────── */

describe("admin overview + resend", () => {
  it("counts pending separately — confirmedTotal excludes pending", async () => {
    await sub("m@n.com");
    await sub("o@p.com");
    await confirmSubscription(tokenFromEmail(0)); // confirms m@n.com (first queued)
    const ov = await getNewsletterOverview(fake as never);
    expect(ov).toBeTruthy();
    expect(ov!.totals.pending).toBe(1);
    expect(ov!.totals.confirmed).toBe(1);
    expect(ov!.confirmedTotal).toBe(1);
  });

  it("resend only works for pending rows", async () => {
    await sub("q@r.com");
    const id = fake.rows("newsletter_subscribers")[0].id as string;
    const ok = await resendConfirmation(fake as never, id);
    expect(ok).toEqual({ ok: true });
    expect(repoHolder.queued.length).toBeGreaterThanOrEqual(2);
    // Confirm it via the RESENT email (tokens were rotated), then resend must 409.
    await confirmSubscription(tokenFromEmail(repoHolder.queued.length - 1));
    const again = await resendConfirmation(fake as never, id);
    expect(again).toMatchObject({ ok: false, status: 409 });
    const missing = await resendConfirmation(fake as never, "00000000-0000-0000-0000-000000000000");
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });
});

/* ── Route level ───────────────────────────────────────────────────────────── */

describe("POST /api/newsletter/subscribe", () => {
  const post = (body: unknown) =>
    subscribePost(new Request("https://z.test/api/newsletter/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never);

  it("200 on valid signup, 422 on invalid, honeypot-consistent", async () => {
    const ok = await post({ email: "route@test.com", segment: "customer", consent: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await post({ email: "nope", segment: "customer", consent: true });
    expect(bad.status).toBe(422);
  });
});
