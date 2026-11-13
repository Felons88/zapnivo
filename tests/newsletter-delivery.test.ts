import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ── Fakes (extended from newsletter.test.ts: .in + head-count support) ────── */

type Row = Record<string, unknown> & { id?: string };

const { dbHolder, repoHolder, mailerHolder, flushHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  repoHolder: { repo: null as unknown, queued: [] as Record<string, unknown>[] },
  mailerHolder: { mailer: { send: vi.fn(async () => {}) } as unknown },
  flushHolder: { result: null as null | { sentIds: string[] } },
}));

function createFakeDb() {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const st = {
      op: "select" as "select" | "insert" | "update",
      filters: [] as [string, unknown][],
      ins: [] as [string, unknown[]][],
      payload: null as unknown,
      want: "many" as "many" | "single" | "maybe",
      head: false,
      orderCol: null as string | null,
      orderAsc: true,
      limitN: Number.POSITIVE_INFINITY,
    };
    const match = (r: Row) =>
      st.filters.every(([c, v]) => r[c] === v) &&
      st.ins.every(([c, vs]) => vs.includes(r[c]));
    const exec = () => {
      if (st.op === "insert") {
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...(st.payload as Row) };
        rows.push(row);
        return { data: st.want === "many" ? [row] : row, error: null, count: null };
      }
      if (st.op === "update") {
        const matched = rows.filter(match);
        for (const r of matched) Object.assign(r, st.payload as Row);
        return { data: st.want === "many" ? matched : matched[0] ?? null, error: null, count: null };
      }
      let out = rows.filter(match);
      if (st.orderCol) {
        const col = st.orderCol;
        out = [...out].sort((a, b) =>
          String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (st.orderAsc ? 1 : -1));
      }
      if (st.limitN !== Number.POSITIVE_INFINITY) out = out.slice(0, st.limitN);
      if (st.head) return { data: null, error: null, count: out.length };
      return { data: st.want === "many" ? out : out[0] ?? null, error: null, count: out.length };
    };
    const b = {
      select: (_cols?: unknown, opts?: { head?: boolean }) => {
        if (opts?.head) st.head = true;
        if (st.op === "select") st.want = "many";
        return b;
      },
      insert: (p: unknown) => { st.op = "insert"; st.payload = p; return b; },
      update: (p: unknown) => { st.op = "update"; st.payload = p; return b; },
      eq: (c: string, v: unknown) => { st.filters.push([c, v]); return b; },
      in: (c: string, vs: unknown[]) => { st.ins.push([c, vs]); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { st.orderCol = c; st.orderAsc = o?.ascending !== false; return b; },
      limit: (n: number) => { st.limitN = n; return b; },
      single: async () => { st.want = "single"; return exec(); },
      maybeSingle: async () => { st.want = "maybe"; return exec(); },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  };
  return { from, _tables: tables, rows: (t: string) => tables[t] ?? [] };
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
  flushOutbox: async () =>
    flushHolder.result ?? { sent: 0, failed: 0, queued: 0, sentIds: [], failedIds: [] },
}));

vi.mock("@/app/api/system/_shared", () => ({
  systemApiGuard: async () => ({
    ok: true,
    user: { id: "00000000-0000-0000-0000-0000000000aa" },
    role: "admin",
    db: dbHolder.db,
  }),
  readJson: async (req: Request) => {
    try {
      const body = await req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  },
}));

const logCalls: { level: string; message: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("@/lib/observability", () => ({
  recordLog: (level: string, message: string, ctx?: { attrs?: Record<string, unknown> }) => {
    logCalls.push({ level, message, attrs: ctx?.attrs });
  },
  reportError: vi.fn(),
  scrub: (s: string) => s,
  newTraceId: () => "t",
}));

import { POST as systemTestPost } from "@/app/api/system/newsletter/test/route";
import {
  isNewsletterTestAddressAllowed,
  newsletterTestAddressesFromEnv,
} from "@/lib/newsletter/core";
import {
  subscribe, confirmSubscription,
  getNewsletterOverview, getNewsletterDelivery, sendOperatorTestDoi,
} from "@/lib/newsletter/service";

/* ── Setup ─────────────────────────────────────────────────────────────────── */

let fake: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  fake = createFakeDb();
  dbHolder.db = fake;
  repoHolder.queued = [];
  flushHolder.result = null;
  repoHolder.repo = {
    queueEmail: async (e: Record<string, unknown>) => {
      const row = { id: `em-${repoHolder.queued.length + 1}`, createdAt: new Date().toISOString(), status: "queued", ...e };
      repoHolder.queued.push(row);
      return row;
    },
  };
  logCalls.length = 0;
  delete process.env.NEWSLETTER_TEST_ADDRESSES;
  delete process.env.BREVO_API_KEY;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => vi.unstubAllGlobals());

const tokenFromEmail = (i = 0): string => {
  const html = String(repoHolder.queued[i]?.html ?? "");
  const m = html.match(/\/api\/newsletter\/confirm\?token=([A-Za-z0-9_\-]+)/);
  expect(m, "confirm link present in DOI email").toBeTruthy();
  return decodeURIComponent(m![1]);
};

/* ── Allowlist (pure) ──────────────────────────────────────────────────────── */

describe("newsletter test allowlist", () => {
  it("allows *@zapnivo.com by default", () => {
    expect(isNewsletterTestAddressAllowed("qa@zapnivo.com")).toBe(true);
    expect(isNewsletterTestAddressAllowed("QA@ZAPNIVO.COM")).toBe(true);
  });
  it("rejects customer/other domains by default", () => {
    expect(isNewsletterTestAddressAllowed("customer@gmail.com")).toBe(false);
    expect(isNewsletterTestAddressAllowed("attacker@zapnivo.com.evil.com")).toBe(false);
    expect(isNewsletterTestAddressAllowed("not-an-email")).toBe(false);
    expect(isNewsletterTestAddressAllowed("")).toBe(false);
  });
  it("honors NEWSLETTER_TEST_ADDRESSES entries", () => {
    expect(isNewsletterTestAddressAllowed("qa@staging.example.com", " QA@Staging.Example.com , other@x.io ")).toBe(true);
    expect(isNewsletterTestAddressAllowed("other@x.io", "qa@staging.example.com")).toBe(false);
    expect(newsletterTestAddressesFromEnv("a@b.com,, bad ,c@d.io")).toEqual(["a@b.com", "c@d.io"]);
  });
});

/* ── Delivery status join ──────────────────────────────────────────────────── */

describe("getNewsletterDelivery", () => {
  const seed = (rows: Record<string, unknown>[]) => {
    fake._tables.email_outbox = rows as Row[];
  };

  it("returns the NEWEST outbox row per recipient, statuses verbatim", async () => {
    seed([
      { to_email: "a@b.com", status: "sent", event: "newsletter.confirm", created_at: "2026-01-02T00:00:00Z" },
      { to_email: "a@b.com", status: "failed", event: "newsletter.confirm", created_at: "2026-01-01T00:00:00Z" },
      { to_email: "c@d.com", status: "queued", event: "newsletter.welcome", created_at: "2026-01-03T00:00:00Z" },
      { to_email: "e@f.com", status: "sent", event: "ticket.reply", created_at: "2026-01-04T00:00:00Z" }, // non-newsletter event ignored
    ]);
    const d = await getNewsletterDelivery(fake as never, ["a@b.com", "c@d.com", "e@f.com"]);
    expect(d["a@b.com"]).toEqual({ status: "sent", event: "newsletter.confirm", at: "2026-01-02T00:00:00Z" });
    expect(d["c@d.com"].status).toBe("queued");
    expect(d["e@f.com"]).toBeUndefined();
  });

  it("returns {} with no db / no emails / on query failure — never fabricates", async () => {
    expect(await getNewsletterDelivery(null, ["a@b.com"])).toEqual({});
    expect(await getNewsletterDelivery(fake as never, [])).toEqual({});
    const broken = { from: () => { throw new Error("down"); } };
    expect(await getNewsletterDelivery(broken as never, ["a@b.com"])).toEqual({});
  });
});

describe("overview delivery column", () => {
  it("attaches latest delivery to recent rows; failed stays honest", async () => {
    fake._tables.email_outbox = [
      { to_email: "m@n.com", status: "failed", event: "newsletter.confirm", created_at: "2026-01-01T00:00:00Z" },
    ] as Row[];
    await subscribe({ email: "m@n.com", segment: "customer", consent: true, source: "website_popup", website: undefined });
    const ov = await getNewsletterOverview(fake as never);
    expect(ov).toBeTruthy();
    expect(ov!.recent[0].delivery?.status).toBe("failed");
    expect(ov!.recent[0].status).toBe("pending"); // delivery failure never flips subscriber state
  });
});

/* ── Operator test-send ────────────────────────────────────────────────────── */

describe("sendOperatorTestDoi", () => {
  it("rejects non-allowlisted addresses with 403 and writes NOTHING", async () => {
    const res = await sendOperatorTestDoi(fake as never, "real.customer@gmail.com");
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(fake.rows("newsletter_subscribers")).toHaveLength(0);
    expect(repoHolder.queued).toHaveLength(0);
  });

  it("creates a pending operator_test row and queues a real DOI email", async () => {
    flushHolder.result = { sentIds: ["em-1"] };
    const res = await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    expect(res).toMatchObject({ ok: true, action: "created", queued: true, sent: true });
    const row = fake.rows("newsletter_subscribers")[0];
    expect(row.source).toBe("operator_test");
    expect(row.status).toBe("pending");
    expect(row.email).toBe("qa@zapnivo.com");
    // DOI email went through the outbox path with the confirm event.
    expect(repoHolder.queued[0]?.event).toBe("newsletter.confirm");
    expect(repoHolder.queued[0]?.to).toBe("qa@zapnivo.com");
    // Confirm link works — the test row completes real DOI like any signup.
    await confirmSubscription(tokenFromEmail());
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("confirmed");
  });

  it("re-sends (rotates tokens) for an existing pending test row", async () => {
    await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    const firstHash = fake.rows("newsletter_subscribers")[0].confirm_token_hash;
    const res = await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    expect(res).toMatchObject({ ok: true, action: "resent" });
    expect(fake.rows("newsletter_subscribers")).toHaveLength(1);
    expect(fake.rows("newsletter_subscribers")[0].confirm_token_hash).not.toBe(firstHash);
  });

  it("refuses confirmed/unsubscribed addresses with 409", async () => {
    await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    await confirmSubscription(tokenFromEmail());
    const res = await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("honest outcome when no mail provider is configured", async () => {
    // getMailer mock returns a mailer, but flushOutbox default returns all-zero → send_failed path
    flushHolder.result = { sentIds: [] };
    const res = await sendOperatorTestDoi(fake as never, "qa@zapnivo.com");
    expect(res).toMatchObject({ ok: true, sent: false, reason: "send_failed" });
  });
});

/* ── Route level: allowlist + audit ────────────────────────────────────────── */

describe("POST /api/system/newsletter/test", () => {
  const auditRows = () => fake.rows("system_audit_events");

  beforeEach(() => {
    // Route guard bypass: mock _shared for this describe via module mock below.
  });

  const post = (email: string) =>
    systemTestPost(new Request("https://system.zapnivo.com/api/system/newsletter/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }) as never);

  it("403 for non-allowlisted, 200 + audit row for allowlisted", async () => {
    const denied = await post("customer@example.com");
    expect(denied.status).toBe(403);
    expect(fake.rows("newsletter_subscribers")).toHaveLength(0);

    flushHolder.result = { sentIds: ["em-1"] };
    const ok = await post("qa@zapnivo.com");
    expect(ok.status).toBe(200);
    const audit = auditRows().find((r) => r.action === "newsletter.test_sent");
    expect(audit, "audit event written").toBeTruthy();
    expect(String(audit!.resource)).toContain("newsletter_subscriber:");
  });
});
