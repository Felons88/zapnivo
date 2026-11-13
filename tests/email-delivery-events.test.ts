import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Email delivery-event webhook pipeline tests:
 *  - svix signature verification (valid / invalid / tampered / expired)
 *  - Resend + Brevo payload → normalized event mapping
 *  - payload sanitization (no content keys, no raw addresses)
 *  - route auth: 503 unconfigured, 401 bad signature, 200 valid
 *  - idempotent duplicate handling
 *  - suppression matrix (hard_bounce/complaint/unsubscribe suppress;
 *    soft_bounce/deferred/accepted/delivered never do)
 *  - unknown recipient → event stored with subscriber_id null
 *  - audit sanitization — no raw email anywhere persisted
 *  - honest delivery ladder + recovery-state honesty
 */

/* ── Fake Supabase (insert/update/select/eq/in/order/limit/head-count) ────── */

type Row = Record<string, unknown> & { id?: string };

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown } }));

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
        const p = st.payload as Row;
        // email_delivery_events unique (provider, provider_event_id) → 23505
        if (table === "email_delivery_events" &&
            rows.some((r) => r.provider === p.provider && r.provider_event_id === p.provider_event_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" }, count: null };
        }
        const row = { id: `row-${++seq}`, created_at: new Date().toISOString(), ...p };
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

const logCalls: { level: string; message: string; attrs?: Record<string, unknown> }[] = [];
vi.mock("@/lib/observability", () => ({
  recordLog: (level: string, message: string, ctx?: { attrs?: Record<string, unknown> }) => {
    logCalls.push({ level, message, attrs: ctx?.attrs });
  },
  reportError: vi.fn(),
  scrub: (s: string) => s,
  newTraceId: () => "t",
}));

import { GET as deliveryGet, POST as deliveryPost } from "@/app/api/webhooks/email/delivery/route";
import {
  deriveDeliveryLadder,
  getEmailDeliveryWebhookStatus,
  getLatestDeliveryEvents,
  getSubscriberDeliveryState,
  recordDeliveryEvent,
} from "@/lib/newsletter/delivery-events";
import {
  hashRecipientEmail,
  isSuppressingEvent,
  parseBrevoEvent,
  parseBrevoEventDetailed,
  parseDeliveryWebhook,
  parseDeliveryWebhookResult,
  parseResendEvent,
  parseResendEventDetailed,
  sanitizeDeliveryPayload,
  verifySharedSecret,
  verifySvixSignature,
} from "@/lib/email-delivery/events";
import { getRecoveryFacts } from "@/lib/system/recovery";

/* ── Setup ─────────────────────────────────────────────────────────────────── */

let fake: ReturnType<typeof createFakeDb>;
const ENV_KEYS = ["RESEND_WEBHOOK_SECRET", "BREVO_WEBHOOK_SECRET", "BREVO_WEBHOOK_ALLOW_QUERY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  fake = createFakeDb();
  dbHolder.db = fake;
  logCalls.length = 0;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

const seedSubscriber = (over: Row = {}) => {
  const row = {
    id: "sub-1",
    email: "ada@example.com",
    status: "confirmed",
    confirm_token_hash: "ch",
    unsubscribe_token_hash: "uh",
    unsubscribed_at: null,
    ...over,
  };
  fake._tables.newsletter_subscribers = [row];
  return row;
};

const req = (body: unknown, headers: Record<string, string> = {}, url = "https://api.zapnivo.com/api/webhooks/email/delivery") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* ── Svix verification ─────────────────────────────────────────────────────── */

const SVIX_SECRET = "whsec_" + Buffer.from("test-secret-key-32bytes!").toString("base64");
const svixSign = (id: string, ts: string, body: string, secret = SVIX_SECRET) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
};
const svixHeaders = (body: string, opts: { id?: string; ts?: string; secret?: string } = {}) => {
  const id = opts.id ?? "msg_1";
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": svixSign(id, ts, body, opts.secret),
  };
};

describe("verifySvixSignature", () => {
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });

  it("accepts a valid signature", () => {
    const h = svixHeaders(body);
    expect(verifySvixSignature({ id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body, secret: SVIX_SECRET })).toBe(true);
  });

  it("rejects wrong secret, tampered body, missing parts, expired timestamp", () => {
    const h = svixHeaders(body);
    const base = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body, secret: SVIX_SECRET };
    expect(verifySvixSignature({ ...base, secret: "whsec_" + Buffer.from("other-key-other-key-1234").toString("base64") })).toBe(false);
    expect(verifySvixSignature({ ...base, body: body + " " })).toBe(false);
    expect(verifySvixSignature({ ...base, id: null })).toBe(false);
    expect(verifySvixSignature({ ...base, signature: null })).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const stale = svixHeaders(body, { ts: old });
    expect(verifySvixSignature({ id: stale["svix-id"], timestamp: stale["svix-timestamp"], signature: stale["svix-signature"], body, secret: SVIX_SECRET })).toBe(false);
    expect(verifySvixSignature({ ...base, signature: "v1,AAAA" })).toBe(false);
  });

  it("accepts when ANY v1 entry matches (key rotation / multi-signature)", () => {
    const h = svixHeaders(body);
    const good = h["svix-signature"];
    const rotated = `v1,${Buffer.from("wrong-sig-wrong-sig-wrong!").toString("base64")} ${good} v1,also-bogus`;
    expect(verifySvixSignature({
      id: h["svix-id"], timestamp: h["svix-timestamp"], signature: rotated, body, secret: SVIX_SECRET,
    })).toBe(true);
  });

  it("ignores non-v1 signature versions — v1a/v2 alone never authenticate", () => {
    const h = svixHeaders(body);
    const sig = h["svix-signature"].slice(3); // strip "v1,"
    for (const header of [`v2,${sig}`, `v1a,${sig}`, `v0,${sig}`, sig]) {
      expect(verifySvixSignature({
        id: h["svix-id"], timestamp: h["svix-timestamp"], signature: header, body, secret: SVIX_SECRET,
      })).toBe(false);
    }
    // Mixed: a valid v1 alongside ignored versions still passes.
    expect(verifySvixSignature({
      id: h["svix-id"], timestamp: h["svix-timestamp"],
      signature: `v2,${sig} ${h["svix-signature"]}`, body, secret: SVIX_SECRET,
    })).toBe(true);
  });

  it("timestamp exactly at the tolerance boundary passes; one ms beyond fails", () => {
    const tsSec = 1_800_000_000;
    const ts = String(tsSec);
    const sig = svixSign("msg_b", ts, body);
    const atBoundary = tsSec * 1000 + 5 * 60_000; // now - ts*1000 === tolerance
    expect(verifySvixSignature({
      id: "msg_b", timestamp: ts, signature: sig, body, secret: SVIX_SECRET, now: atBoundary,
    })).toBe(true);
    expect(verifySvixSignature({
      id: "msg_b", timestamp: ts, signature: sig, body, secret: SVIX_SECRET, now: atBoundary + 1,
    })).toBe(false);
    // Future timestamps beyond tolerance are also rejected.
    expect(verifySvixSignature({
      id: "msg_b", timestamp: ts, signature: sig, body, secret: SVIX_SECRET,
      now: tsSec * 1000 - 5 * 60_000 - 1,
    })).toBe(false);
  });

  it("rejects non-integer / non-positive timestamps", () => {
    const sig = "v1,AAAA";
    for (const ts of ["1800000000.5", "0", "-5", "abc", ""]) {
      expect(verifySvixSignature({
        id: "m", timestamp: ts, signature: sig, body, secret: SVIX_SECRET,
      })).toBe(false);
    }
  });

  it("verifies signatures over exact bytes — unicode/multibyte bodies", () => {
    const uni = JSON.stringify({ type: "email.delivered", note: "héllo wörld —  🎉", data: { to: ["a@b.co"] } });
    const h = svixHeaders(uni);
    expect(verifySvixSignature({
      id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body: uni, secret: SVIX_SECRET,
    })).toBe(true);
    // A visually identical but byte-different body must fail.
    const tampered = uni.replace("🎉", "🎊");
    expect(verifySvixSignature({
      id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body: tampered, secret: SVIX_SECRET,
    })).toBe(false);
  });

  it("signature computed for a different body never validates", () => {
    const other = JSON.stringify({ type: "email.bounced", data: { to: ["x@y.z"] } });
    const h = svixHeaders(other); // signed 'other'
    expect(verifySvixSignature({
      id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], body, secret: SVIX_SECRET,
    })).toBe(false);
  });

  it("verifySharedSecret is constant-time equality", () => {
    expect(verifySharedSecret("s3cret", "s3cret")).toBe(true);
    expect(verifySharedSecret("s3cret", "s3creX")).toBe(false);
    expect(verifySharedSecret(null, "s3cret")).toBe(false);
    expect(verifySharedSecret("s3cret", "")).toBe(false);
  });
});

/* ── Payload parsing / mapping ─────────────────────────────────────────────── */

describe("parseResendEvent", () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    created_at: "2026-02-01T10:00:00.000Z",
    data: { email_id: "re_123", to: ["Ada@Example.com"], from: "hello@zapnivo.com", ...extra },
  });

  it("maps delivery lifecycle events", () => {
    expect(parseResendEvent(ev("email.sent"))?.eventType).toBe("accepted");
    expect(parseResendEvent(ev("email.delivered"))?.eventType).toBe("delivered");
    expect(parseResendEvent(ev("email.delivery_delayed"))?.eventType).toBe("deferred");
    expect(parseResendEvent(ev("email.complained"))?.eventType).toBe("complaint");
    expect(parseResendEvent(ev("email.bounced"))?.eventType).toBe("hard_bounce");
    expect(parseResendEvent(ev("email.bounced", { bounce: { type: "Transient" } }))?.eventType).toBe("soft_bounce");
    expect(parseResendEvent(ev("email.failed"))?.eventType).toBe("failed");
  });

  it("ignores opens/clicks and malformed payloads", () => {
    expect(parseResendEvent(ev("email.opened"))).toBeNull();
    expect(parseResendEvent(ev("email.clicked"))).toBeNull();
    expect(parseResendEvent({ type: "email.delivered", data: {} })).toBeNull(); // no recipient
    expect(parseResendEvent("nope")).toBeNull();
    expect(parseResendEvent(null)).toBeNull();
  });

  it("normalizes recipient, idempotency key and timestamp", () => {
    const e = parseResendEvent(ev("email.delivered"))!;
    expect(e.provider).toBe("resend");
    expect(e.providerEventId).toBe("resend:re_123");
    expect(e.recipientEmail).toBe("ada@example.com");
    expect(e.occurredAt).toBe("2026-02-01T10:00:00.000Z");
  });
});

describe("parseBrevoEvent", () => {
  it("maps Brevo transactional events", () => {
    const mk = (event: string) => ({ event, email: "ada@example.com", id: 987, ts: 1769900000 });
    expect(parseBrevoEvent(mk("request"))?.eventType).toBe("accepted");
    expect(parseBrevoEvent(mk("delivered"))?.eventType).toBe("delivered");
    expect(parseBrevoEvent(mk("deferred"))?.eventType).toBe("deferred");
    expect(parseBrevoEvent(mk("soft_bounce"))?.eventType).toBe("soft_bounce");
    expect(parseBrevoEvent(mk("hard_bounce"))?.eventType).toBe("hard_bounce");
    expect(parseBrevoEvent(mk("blocked"))?.eventType).toBe("failed");
    expect(parseBrevoEvent(mk("invalid_email"))?.eventType).toBe("failed");
    expect(parseBrevoEvent(mk("spam"))?.eventType).toBe("complaint");
    expect(parseBrevoEvent(mk("unsubscribed"))?.eventType).toBe("unsubscribe");
    expect(parseBrevoEvent(mk("opened"))).toBeNull();
    expect(parseBrevoEvent(mk("click"))).toBeNull();
  });

  it("handles array payloads via parseDeliveryWebhook", () => {
    const body = [
      { event: "delivered", email: "a@b.com", id: 1, ts: 1769900000 },
      { event: "opened", email: "a@b.com", id: 1, ts: 1769900001 },
      { event: "hard_bounce", email: "c@d.com", id: 2, ts: 1769900002 },
    ];
    const evs = parseDeliveryWebhook("brevo", body);
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => e.eventType)).toEqual(["delivered", "hard_bounce"]);
    // Same message id, different events → distinct idempotency keys.
    expect(evs[0].providerEventId).not.toBe(evs[1].providerEventId);
    expect(evs[0].providerEventId).toContain("delivered");
  });
});

describe("parse outcome tri-state (ignore vs malformed)", () => {
  it("recognized type without recipient → malformed; untracked/unknown → ignore", () => {
    expect(parseResendEventDetailed({ type: "email.delivered", data: { email_id: "e1" } }).kind).toBe("malformed");
    expect(parseResendEventDetailed({ type: "email.opened", data: {} }).kind).toBe("ignore");
    expect(parseResendEventDetailed({ type: "email.sms", data: {} }).kind).toBe("ignore"); // unknown future type
    expect(parseResendEventDetailed({ data: {} }).kind).toBe("malformed"); // no type at all
    expect(parseResendEventDetailed("nope").kind).toBe("malformed");
    expect(parseResendEventDetailed(null).kind).toBe("malformed");
    expect(parseBrevoEventDetailed({ event: "hard_bounce" }).kind).toBe("malformed"); // no email
    expect(parseBrevoEventDetailed({ event: "opened", email: "a@b.com" }).kind).toBe("ignore");
    expect(parseBrevoEventDetailed({ email: "a@b.com" }).kind).toBe("malformed"); // no event
    expect(parseBrevoEventDetailed(42).kind).toBe("malformed");
  });

  it("parseDeliveryWebhookResult counts malformed alongside valid events", () => {
    const r = parseDeliveryWebhookResult("brevo", [
      { event: "delivered", email: "a@b.com", id: 1, ts: 1769900000 },
      { event: "hard_bounce", id: 2, ts: 1769900001 }, // missing email → malformed
      { event: "click", email: "a@b.com", id: 3, ts: 1769900002 }, // ignored
    ]);
    expect(r.events).toHaveLength(1);
    expect(r.malformed).toBe(1);
    // back-compat wrapper still returns events only
    expect(parseDeliveryWebhook("brevo", [
      { event: "delivered", email: "a@b.com", id: 1, ts: 1769900000 },
      { event: "hard_bounce", id: 2, ts: 1769900001 },
    ])).toHaveLength(1);
  });

  it("Brevo 'sent' maps to accepted (provider alias of request)", () => {
    const e = parseBrevoEvent({ event: "sent", email: "a@b.com", id: 9, ts: 1769900000 });
    expect(e?.eventType).toBe("accepted");
  });
});

describe("sanitizeDeliveryPayload", () => {
  it("drops content keys and redacts email addresses in surviving strings", () => {
    const out = sanitizeDeliveryPayload({
      event: "delivered",
      email: "victim@example.com",
      subject: "Your receipt",
      html: "<p>secret</p>",
      headers: { "x-auth": "dkim=pass" },
      nested: { note: "reply to bob@corp.com please", ok: true, n: 3 },
      list: ["x@y.com", 1, null],
    });
    expect(out.event).toBe("delivered");
    expect(out.subject).toBeUndefined();
    expect(out.html).toBeUndefined();
    expect(out.headers).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("victim@example.com");
    expect(JSON.stringify(out)).not.toContain("bob@corp.com");
    expect(JSON.stringify(out)).not.toContain("x@y.com");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.note).toBe("reply to [email] please");
    expect(nested.ok).toBe(true);
  });
});

/* ── recordDeliveryEvent: correlation, idempotency, suppression ────────────── */

const normEvent = (over: Partial<Parameters<typeof recordDeliveryEvent>[1]> = {}) => ({
  provider: "resend" as const,
  providerEventId: "resend:evt-1",
  eventType: "delivered" as const,
  recipientEmail: "ada@example.com",
  occurredAt: "2026-02-01T10:00:00.000Z",
  payload: { event: "email.delivered" },
  ...over,
});

describe("recordDeliveryEvent", () => {
  it("stores event with subscriber correlation, no raw email, marks processed", async () => {
    seedSubscriber();
    const res = await recordDeliveryEvent(fake as never, normEvent());
    expect(res).toMatchObject({ ok: true, duplicate: false, suppressed: false, subscriberId: "sub-1" });
    const row = fake.rows("email_delivery_events")[0];
    expect(row.provider).toBe("resend");
    expect(row.event_type).toBe("delivered");
    expect(row.subscriber_id).toBe("sub-1");
    expect(row.recipient_hash).toBe(hashRecipientEmail("ada@example.com"));
    expect(row.processed).toBe(true);
    expect(JSON.stringify(row)).not.toContain("ada@example.com");
  });

  it("returns duplicate on provider replay — no second row", async () => {
    seedSubscriber();
    await recordDeliveryEvent(fake as never, normEvent());
    const res = await recordDeliveryEvent(fake as never, normEvent());
    expect(res).toMatchObject({ ok: true, duplicate: true });
    expect(fake.rows("email_delivery_events")).toHaveLength(1);
  });

  it("stores unknown recipients with subscriber_id null", async () => {
    const res = await recordDeliveryEvent(fake as never, normEvent({ recipientEmail: "stranger@nowhere.io" }));
    expect(res).toMatchObject({ ok: true, subscriberId: null });
    expect(fake.rows("email_delivery_events")[0].subscriber_id).toBeNull();
  });

  it.each([
    ["hard_bounce", "resend"],
    ["complaint", "brevo"],
    ["unsubscribe", "brevo"],
  ] as const)("suppresses subscriber on %s (%s)", async (eventType, provider) => {
    seedSubscriber();
    const res = await recordDeliveryEvent(fake as never, normEvent({
      provider, eventType: eventType as never, providerEventId: `${provider}:${eventType}-1`,
    }));
    expect(res).toMatchObject({ ok: true, suppressed: true });
    const sub = fake.rows("newsletter_subscribers")[0];
    expect(sub.status).toBe("unsubscribed");
    expect(sub.unsubscribed_at).toBeTruthy();
    expect(sub.confirm_token_hash).toBeNull();
    expect(sub.unsubscribe_token_hash).toBeNull();
  });

  it.each(["accepted", "delivered", "deferred", "soft_bounce", "failed"] as const)(
    "never suppresses on %s", async (eventType) => {
      seedSubscriber();
      const res = await recordDeliveryEvent(fake as never, normEvent({ eventType, providerEventId: `resend:${eventType}-1` }));
      expect(res).toMatchObject({ ok: true, suppressed: false });
      expect(fake.rows("newsletter_subscribers")[0].status).toBe("confirmed");
    },
  );

  it("suppression is idempotent — already-unsubscribed rows untouched", async () => {
    seedSubscriber({ status: "unsubscribed", unsubscribed_at: "2026-01-01T00:00:00Z" });
    const res = await recordDeliveryEvent(fake as never, normEvent({ eventType: "hard_bounce", providerEventId: "resend:hb-2" }));
    expect(res).toMatchObject({ ok: true, suppressed: false });
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("unsubscribed");
  });

  it("out-of-order delivery: 'delivered' after 'hard_bounce' never un-suppresses", async () => {
    seedSubscriber();
    // hard_bounce arrives first (older occurred_at), delivered arrives later.
    await recordDeliveryEvent(fake as never, normEvent({
      eventType: "hard_bounce", providerEventId: "resend:hb-ord", occurredAt: "2026-02-01T09:00:00.000Z",
    }));
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("unsubscribed");
    const res = await recordDeliveryEvent(fake as never, normEvent({
      eventType: "delivered", providerEventId: "resend:del-ord", occurredAt: "2026-02-01T11:00:00.000Z",
    }));
    expect(res).toMatchObject({ ok: true, suppressed: false });
    // Terminal state is NOT undone by the later non-suppressing event.
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("unsubscribed");
    // Both events are stored — nothing is dropped.
    expect(fake.rows("email_delivery_events")).toHaveLength(2);
  });

  it("provider replay of an unprocessed row re-runs suppression (retry path)", async () => {
    seedSubscriber();
    const ev = normEvent({ eventType: "hard_bounce", providerEventId: "resend:hb-retry" });
    await recordDeliveryEvent(fake as never, ev);
    expect(fake.rows("email_delivery_events")[0].processed).toBe(true);
    // Simulate the failure mode: row stored but suppression never applied.
    fake.rows("email_delivery_events")[0].processed = false;
    fake.rows("newsletter_subscribers")[0].status = "confirmed";
    const res = await recordDeliveryEvent(fake as never, ev);
    expect(res).toMatchObject({ ok: true, duplicate: true, suppressed: true });
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("unsubscribed");
    expect(fake.rows("email_delivery_events")).toHaveLength(1); // still one row
    expect(fake.rows("email_delivery_events")[0].processed).toBe(true);
  });

  it("audit detail contains no raw email", async () => {
    seedSubscriber();
    await recordDeliveryEvent(fake as never, normEvent({ eventType: "hard_bounce", providerEventId: "resend:hb-audit" }));
    const audit = fake.rows("system_audit_events").find((r) => r.action === "email.delivery_event");
    expect(audit, "audit row written").toBeTruthy();
    expect(JSON.stringify(audit!.detail)).not.toContain("ada@example.com");
    expect((audit!.detail as Row).subscriber_id).toBe("sub-1");
  });
});

/* ── Route level ───────────────────────────────────────────────────────────── */

describe("POST /api/webhooks/email/delivery", () => {
  const resendBody = (type = "email.delivered") => JSON.stringify({
    type, created_at: "2026-02-01T10:00:00Z",
    data: { email_id: "re_route_1", to: ["ada@example.com"], from: "hello@zapnivo.com" },
  });

  it("503 when no webhook secret is configured", async () => {
    const res = await deliveryPost(req(resendBody()) as never);
    expect(res.status).toBe(503);
    expect(fake.rows("email_delivery_events")).toHaveLength(0);
  });

  it("401 on invalid svix signature; nothing stored", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const body = resendBody();
    const h = svixHeaders(body, { secret: "whsec_" + Buffer.from("wrong-wrong-wrong-wrong!").toString("base64") });
    const res = await deliveryPost(req(body, h) as never);
    expect(res.status).toBe(401);
    expect(fake.rows("email_delivery_events")).toHaveLength(0);
  });

  it("200 + stores event for valid Resend signature", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    seedSubscriber();
    const body = resendBody();
    const res = await deliveryPost(req(body, svixHeaders(body)) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processed: 1 });
    expect(fake.rows("email_delivery_events")).toHaveLength(1);
  });

  it("replayed provider event → 200 duplicate, single row", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const body = resendBody();
    await deliveryPost(req(body, svixHeaders(body, { id: "msg_a" })) as never);
    const res = await deliveryPost(req(body, svixHeaders(body, { id: "msg_b" })) as never); // same email_id, new svix id
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicates: 1, processed: 0 });
    expect(fake.rows("email_delivery_events")).toHaveLength(1);
  });

  it("Brevo shared-secret auth via header; wrong key → 401", async () => {
    process.env.BREVO_WEBHOOK_SECRET = "wh-gA3k9";
    const body = JSON.stringify([{ event: "hard_bounce", email: "ada@example.com", id: 42, ts: 1769900000 }]);
    const bad = await deliveryPost(req(body, { "x-zapnivo-delivery-key": "nope" }) as never);
    expect(bad.status).toBe(401);
    const good = await deliveryPost(req(body, { "x-zapnivo-delivery-key": "wh-gA3k9" }) as never);
    expect(good.status).toBe(200);
    const row = fake.rows("email_delivery_events")[0];
    expect(row.provider).toBe("brevo");
    expect(row.event_type).toBe("hard_bounce");
  });

  it("Brevo ?key= param auth works but logs a deprecation warning; untracked → ignored 200", async () => {
    process.env.BREVO_WEBHOOK_SECRET = "wh-gA3k9";
    const body = JSON.stringify({ event: "opened", email: "ada@example.com", id: 7, ts: 1769900000 });
    const res = await deliveryPost(req(body, {}, "https://api.zapnivo.com/api/webhooks/email/delivery?key=wh-gA3k9") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(fake.rows("email_delivery_events")).toHaveLength(0);
    expect(logCalls.some((l) => l.message === "brevo_delivery_webhook_query_key_deprecated")).toBe(true);
    // The secret itself must never appear in logs.
    expect(JSON.stringify(logCalls)).not.toContain("wh-gA3k9");
  });

  it("BREVO_WEBHOOK_ALLOW_QUERY=0 disables ?key= auth (header still works)", async () => {
    process.env.BREVO_WEBHOOK_SECRET = "wh-gA3k9";
    process.env.BREVO_WEBHOOK_ALLOW_QUERY = "0";
    const body = JSON.stringify({ event: "delivered", email: "ada@example.com", id: 8, ts: 1769900000 });
    const viaQuery = await deliveryPost(req(body, {}, "https://api.zapnivo.com/api/webhooks/email/delivery?key=wh-gA3k9") as never);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await deliveryPost(req(body, { "x-zapnivo-delivery-key": "wh-gA3k9" }) as never);
    expect(viaHeader.status).toBe(200);
  });

  it("Brevo header auth beats a wrong ?key=; no secret → 401; empty header → 401", async () => {
    process.env.BREVO_WEBHOOK_SECRET = "wh-gA3k9";
    const body = JSON.stringify({ event: "delivered", email: "ada@example.com", id: 9, ts: 1769900000 });
    const badQuery = await deliveryPost(req(body, {}, "https://api.zapnivo.com/api/webhooks/email/delivery?key=wrong") as never);
    expect(badQuery.status).toBe(401);
    const emptyHeader = await deliveryPost(req(body, { "x-zapnivo-delivery-key": "" }) as never);
    expect(emptyHeader.status).toBe(401);
  });

  it("malformed payloads → 400 (provider stops retrying); valid-but-irrelevant → 200 ignored", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    // Recognized type, missing recipient → malformed.
    const bad = JSON.stringify({ type: "email.delivered", created_at: "2026-02-01T10:00:00Z", data: { email_id: "e9" } });
    const res = await deliveryPost(req(bad, svixHeaders(bad)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "malformed_payload" });
    expect(fake.rows("email_delivery_events")).toHaveLength(0);
    // Non-JSON → 400; valid JSON but not an event object → 400.
    const notJson = "this is not json";
    expect((await deliveryPost(req(notJson, svixHeaders(notJson)) as never)).status).toBe(400);
    const scalar = JSON.stringify("just a string");
    expect((await deliveryPost(req(scalar, svixHeaders(scalar)) as never)).status).toBe(400);
    // Untracked-but-valid event type → 200 ignored.
    const opened = JSON.stringify({ type: "email.opened", data: { email_id: "e1", to: ["a@b.com"] } });
    const ok = await deliveryPost(req(opened, svixHeaders(opened)) as never);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, ignored: true });
  });

  it("mixed batch: valid events stored, malformed remainder → 400", async () => {
    process.env.BREVO_WEBHOOK_SECRET = "wh-gA3k9";
    const body = JSON.stringify([
      { event: "delivered", email: "ada@example.com", id: 11, ts: 1769900000 },
      { event: "hard_bounce", id: 12, ts: 1769900001 }, // missing email → malformed
    ]);
    const res = await deliveryPost(req(body, { "x-zapnivo-delivery-key": "wh-gA3k9" }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "malformed_payload", processed: 1, malformed: 1 });
    expect(fake.rows("email_delivery_events")).toHaveLength(1);
  });

  it("non-JSON content-type → 415 before auth", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const body = resendBody();
    const res = await deliveryPost(new Request("https://api.zapnivo.com/api/webhooks/email/delivery", {
      method: "POST",
      headers: { "content-type": "text/plain", ...svixHeaders(body) },
      body,
    }) as never);
    expect(res.status).toBe(415);
  });

  it("suppression via route: hard_bounce unsubscribes the subscriber", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    seedSubscriber();
    const body = JSON.stringify({
      type: "email.bounced", created_at: "2026-02-01T10:00:00Z",
      data: { email_id: "re_b1", to: ["ada@example.com"], bounce: { type: "Permanent" } },
    });
    const res = await deliveryPost(req(body, svixHeaders(body)) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suppressed: 1 });
    expect(fake.rows("newsletter_subscribers")[0].status).toBe("unsubscribed");
  });

  it("GET → 405; oversized body → 413", async () => {
    expect((await deliveryGet()).status).toBe(405);
    process.env.RESEND_WEBHOOK_SECRET = SVIX_SECRET;
    const big = "x".repeat(200_000);
    const res = await deliveryPost(req(big, svixHeaders(big)) as never);
    expect(res.status).toBe(413);
  });
});

/* ── Honest delivery ladder + admin joins ──────────────────────────────────── */

describe("delivery ladder", () => {
  it("deriveDeliveryLadder maps events and outbox honestly", () => {
    expect(deriveDeliveryLadder(null, null)).toBe("none");
    expect(deriveDeliveryLadder("queued", null)).toBe("queued");
    expect(deriveDeliveryLadder("sent", null)).toBe("accepted"); // sent ≠ delivered
    expect(deriveDeliveryLadder("failed", null)).toBe("failed");
    expect(deriveDeliveryLadder("sent", "delivered")).toBe("delivered");
    expect(deriveDeliveryLadder("sent", "deferred")).toBe("deferred");
    expect(deriveDeliveryLadder("sent", "soft_bounce")).toBe("soft_bounced");
    expect(deriveDeliveryLadder("sent", "hard_bounce")).toBe("failed");
    expect(deriveDeliveryLadder("sent", "complaint")).toBe("complained");
    expect(isSuppressingEvent("delivered")).toBe(false);
    expect(isSuppressingEvent("hard_bounce")).toBe(true);
  });

  it("getSubscriberDeliveryState returns latest event + outbox truth", async () => {
    seedSubscriber();
    fake._tables.email_outbox = [
      { id: "o1", to_email: "ada@example.com", status: "sent", event: "newsletter.confirm", created_at: "2026-02-01T09:00:00Z" },
    ];
    fake._tables.email_delivery_events = [
      { id: "e1", subscriber_id: "sub-1", provider: "resend", event_type: "delivered", occurred_at: "2026-02-01T10:00:00Z", provider_event_id: "x", recipient_hash: "h", payload: {}, received_at: "", processed: true },
    ];
    const s = await getSubscriberDeliveryState(fake as never, "sub-1");
    expect(s).toMatchObject({ state: "delivered", outboxStatus: "sent" });
    expect(s!.event).toMatchObject({ eventType: "delivered", provider: "resend" });
    expect(await getSubscriberDeliveryState(fake as never, "missing")).toBeNull();
    expect(await getSubscriberDeliveryState(null, "sub-1")).toBeNull();
  });

  it("out-of-order events: later 'delivered' does NOT mask earlier 'hard_bounce'", async () => {
    seedSubscriber({ status: "unsubscribed" });
    fake._tables.email_delivery_events = [
      // newest by occurred_at is 'delivered' — naive latest-wins would lie.
      { id: "e2", subscriber_id: "sub-1", provider: "resend", event_type: "delivered", occurred_at: "2026-02-01T11:00:00Z", provider_event_id: "d", recipient_hash: "h", payload: {}, received_at: "", processed: true },
      { id: "e1", subscriber_id: "sub-1", provider: "resend", event_type: "hard_bounce", occurred_at: "2026-02-01T09:00:00Z", provider_event_id: "b", recipient_hash: "h", payload: {}, received_at: "", processed: true },
    ];
    const s = await getSubscriberDeliveryState(fake as never, "sub-1");
    expect(s!.event!.eventType).toBe("hard_bounce");
    expect(s!.state).toBe("failed"); // suppressing severity wins over arrival order
    // Non-suppressing mixes still resolve to the newest event.
    fake._tables.email_delivery_events = [
      { id: "e3", subscriber_id: "sub-1", provider: "resend", event_type: "delivered", occurred_at: "2026-02-01T12:00:00Z", provider_event_id: "d2", recipient_hash: "h", payload: {}, received_at: "", processed: true },
      { id: "e4", subscriber_id: "sub-1", provider: "resend", event_type: "deferred", occurred_at: "2026-02-01T10:00:00Z", provider_event_id: "df", recipient_hash: "h", payload: {}, received_at: "", processed: true },
    ];
    const s2 = await getSubscriberDeliveryState(fake as never, "sub-1");
    expect(s2!.event!.eventType).toBe("delivered");
    expect(s2!.state).toBe("delivered");
  });

  it("getLatestDeliveryEvents picks newest per subscriber, bounded", async () => {
    fake._tables.email_delivery_events = [
      { subscriber_id: "s1", provider: "resend", event_type: "delivered", occurred_at: "2026-02-02T00:00:00Z" },
      { subscriber_id: "s1", provider: "resend", event_type: "accepted", occurred_at: "2026-02-01T00:00:00Z" },
      { subscriber_id: "s2", provider: "brevo", event_type: "hard_bounce", occurred_at: "2026-02-01T12:00:00Z" },
      { subscriber_id: null, provider: "resend", event_type: "delivered", occurred_at: "2026-02-03T00:00:00Z" },
    ];
    const m = await getLatestDeliveryEvents(fake as never, ["s1", "s2", "s3"]);
    expect(m.s1.eventType).toBe("delivered");
    expect(m.s2.eventType).toBe("hard_bounce");
    expect(m.s3).toBeUndefined();
  });

  it("getEmailDeliveryWebhookStatus reports env flags + latest event honestly", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.BREVO_WEBHOOK_SECRET;
    let s = await getEmailDeliveryWebhookStatus(fake as never);
    expect(s.resendConfigured).toBe(false);
    expect(s.brevoConfigured).toBe(false);
    expect(s.lastEventAt).toBeNull();

    process.env.RESEND_WEBHOOK_SECRET = "x";
    fake._tables.email_delivery_events = [
      { provider: "resend", event_type: "delivered", occurred_at: "2026-02-01T10:00:00Z" },
    ];
    s = await getEmailDeliveryWebhookStatus(fake as never);
    expect(s.resendConfigured).toBe(true);
    expect(s.lastEventType).toBe("delivered");
    expect(s.totalEvents).toBe(1);
    // null db → flags only, no fabricated data
    const n = await getEmailDeliveryWebhookStatus(null);
    expect(n.lastEventAt).toBeNull();
    expect(n.totalEvents).toBeNull();
  });
});

/* ── Recovery honesty ───────────────────────────────────────────────────────── */

describe("recovery state honesty", () => {
  it("never claims a verified backup — provider-managed + unverified", () => {
    const f = getRecoveryFacts();
    expect(f.backupStatus).toBe("managed_by_provider_unverified");
    expect(f.pitrStatus).toBe("unverified");
    expect(f.rpoTargetMinutes).toBeNull();
    expect(f.rtoTargetMinutes).toBeNull();
    expect(f.backupDetail).toMatch(/CANNOT be verified/i);
  });
});
