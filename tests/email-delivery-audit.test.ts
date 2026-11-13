import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase-2.7 communications audit tests:
 *  - tri-state send (queued vs delivered) so threads never claim "waiting" on an unsent email
 *  - monitored registry addresses (security@, partners@, …) reach the receptionist
 *  - staff alerting on escalation/quarantine with cooldown dedup
 *  - mailerConfigured no longer requires SUPPORT_FROM_EMAIL
 *  - bounded failed-outbox retry decision
 */

import { alertStaff, sendToCustomerOutcome } from "@/lib/email-triggers";
import { BrevoMailer, mailerConfigured, outboxRetryEligible, requeueFailedOutbox } from "@/lib/helpdesk/mailer";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { setRepoForTests } from "@/lib/helpdesk/repo";
import { processInboundMail } from "@/lib/inbound/processor";
import { ingestGeneralMail, monitoredRecipient, resetStaffAlertCooldowns, type InboundMail } from "@/lib/receptionist/ingest";
import { approveDraft, replyToThread } from "@/lib/receptionist/service";

/* ── Fake Supabase (same pattern as tests/receptionist.test.ts) ───────────── */

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const rows = tables[table] ?? (tables[table] = []);
    const state: {
      filters: ((r: Row) => boolean)[];
      op: "select" | "insert" | "update" | "delete";
      patch: Row;
      insertRow: Row | null;
      orderCol: string | null;
      orderAsc: boolean;
      lim: number | null;
    } = { filters: [], op: "select", patch: {}, insertRow: null, orderCol: null, orderAsc: true, lim: null };

    const eqVal = (a: unknown, b: unknown) =>
      typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
    const matched = () => {
      let m = rows.filter((r) => state.filters.every((f) => f(r)));
      if (state.orderCol) {
        const c = state.orderCol;
        m = [...m].sort((x, y) => String(x[c] ?? "").localeCompare(String(y[c] ?? "")) * (state.orderAsc ? 1 : -1));
      }
      if (state.lim != null) m = m.slice(0, state.lim);
      return m;
    };

    const api: Record<string, unknown> = {};
    const self = () => api;
    api.select = () => self();
    api.insert = (row: Row) => { state.op = "insert"; state.insertRow = row; return self(); };
    api.update = (patch: Row) => { state.op = "update"; state.patch = patch; return self(); };
    api.delete = () => { state.op = "delete"; return self(); };
    api.eq = (k: string, v: unknown) => { state.filters.push((r) => eqVal(r[k], v)); return self(); };
    api.neq = (k: string, v: unknown) => { state.filters.push((r) => !eqVal(r[k], v)); return self(); };
    api.in = (k: string, vals: unknown[]) => { state.filters.push((r) => vals.some((v) => eqVal(r[k], v))); return self(); };
    api.order = (k: string, o?: { ascending?: boolean }) => { state.orderCol = k; state.orderAsc = o?.ascending !== false; return self(); };
    api.limit = (n: number) => { state.lim = n; return self(); };
    api.single = async () => {
      if (state.op === "insert" && state.insertRow) {
        const row = { id: `id-${rows.length + 1}`, created_at: new Date().toISOString(), ...state.insertRow };
        rows.push(row);
        return { data: { ...row }, error: null };
      }
      const m = matched();
      return { data: m[0] ? { ...m[0] } : null, error: null };
    };
    api.maybeSingle = api.single;
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let data: unknown = null;
      if (state.op === "insert" && state.insertRow) {
        const row = { id: `id-${rows.length + 1}`, created_at: new Date().toISOString(), ...state.insertRow };
        rows.push(row);
        data = { ...row };
      } else if (state.op === "update") {
        for (const r of matched()) Object.assign(r, state.patch);
        data = matched().map((r) => ({ ...r }));
      } else if (state.op === "delete") {
        const kill = new Set(matched());
        for (let i = rows.length - 1; i >= 0; i--) if (kill.has(rows[i])) rows.splice(i, 1);
        data = null;
      } else {
        data = matched().map((r) => ({ ...r }));
      }
      return Promise.resolve({ data, error: null }).then(res, rej);
    };
    return api;
  };
  return { tables, from: from as (t: string) => ReturnType<typeof from> } as never;
}

const tables = (db: ReturnType<typeof fakeDb>) => (db as never as { tables: Record<string, Row[]> }).tables;

const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
  from: "sender@example.com",
  subject: "Hello there",
  text: "Hi, I have a general question about Zapnivo.",
  messageId: `<m-${Math.random().toString(36).slice(2)}@x>`,
  inReplyTo: null,
  recipients: ["hello@zapnivo.com"],
  ...over,
});

const THREAD = {
  id: "t-1", sender_email: "customer@example.com", subject: "Hello there",
  category: "general", status: "assigned", priority: "normal", autonomy_level: 1,
  assigned_to: null, ai_confidence: null, escalation_reason: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_message_at: new Date().toISOString(),
};

const STAFF = [
  { email: "admin@zapnivo.com", role: "admin" },
  { email: "staff@zapnivo.com", role: "staff" },
];

const ENV_KEYS = [
  "RESEND_API_KEY", "BREVO_API_KEY", "SUPPORT_FROM_EMAIL", "OPENROUTER_API_KEY",
  "RECEPTIONIST_AUTONOMY", "RECEPTIONIST_ALERT_COOLDOWN_MS", "ALERT_WEBHOOK_URL", "GENERAL_INBOX",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  setRepoForTests(undefined);
  resetStaffAlertCooldowns();
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setRepoForTests(undefined);
});

/* ── mailerConfigured relaxation ──────────────────────────────────────────── */

describe("mailerConfigured", () => {
  it("is false with no provider key, true with a key and no SUPPORT_FROM_EMAIL", () => {
    expect(mailerConfigured()).toBe(false);
    process.env.BREVO_API_KEY = "k";
    expect(mailerConfigured()).toBe(true);
    delete process.env.BREVO_API_KEY;
    process.env.RESEND_API_KEY = "k";
    expect(mailerConfigured()).toBe(true);
  });

  it("BrevoMailer falls back to the registry general sender when SUPPORT_FROM_EMAIL is unset", async () => {
    process.env.BREVO_API_KEY = "k";
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", spy);
    await new BrevoMailer().send({ to: "c@example.com", subject: "hi", body: "b" });
    const payload = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(payload.sender.email).toBe("hello@zapnivo.com");
  });
});

/* ── Tri-state send ───────────────────────────────────────────────────────── */

describe("tri-state send", () => {
  it("sendToCustomerOutcome reports queued/no_provider when no mailer is configured", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    const res = await sendToCustomerOutcome("c@example.com", "s", "b", null);
    expect(res).toEqual({ queued: true, sent: false, reason: "no_provider" });
    expect(await repo.listEmails("queued")).toHaveLength(1);
  });

  it("replyToThread does NOT mark waiting or log outbound when the email is only queued", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    const db = fakeDb({ receptionist_threads: [{ ...THREAD }], receptionist_messages: [], receptionist_audit_events: [] });
    const r = await replyToThread(db as never, "t-1", { id: "u1", email: "staff@zapnivo.com" }, "Happy to help!");
    expect(r).toEqual({ ok: true, delivery: "queued" });
    const t = tables(db).receptionist_threads[0];
    expect(t.status).toBe("assigned"); // NOT "waiting"
    expect(tables(db).receptionist_messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
    expect(tables(db).receptionist_audit_events.some((a) => a.action === "reply.queued")).toBe(true);
    // The outbox row still exists for later flush — queueing is preserved.
    expect(await repo.listEmails("queued")).toHaveLength(1);
  });

  it("replyToThread marks waiting and logs outbound when the provider confirms", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    process.env.RESEND_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    const db = fakeDb({ receptionist_threads: [{ ...THREAD }], receptionist_messages: [], receptionist_audit_events: [] });
    const r = await replyToThread(db as never, "t-1", { id: "u1", email: "staff@zapnivo.com" }, "Happy to help!");
    expect(r).toEqual({ ok: true, delivery: "sent" });
    expect(tables(db).receptionist_threads[0].status).toBe("waiting");
    expect(tables(db).receptionist_messages.some((m) => m.direction === "outbound")).toBe(true);
    expect((await repo.listEmails("sent"))).toHaveLength(1);
  });

  it("approveDraft stays out of waiting and keeps the draft when only queued", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    const db = fakeDb({
      receptionist_threads: [{ ...THREAD, status: "awaiting_approval" }],
      receptionist_messages: [{ id: "m1", thread_id: "t-1", direction: "draft", from_addr: "hello@zapnivo.com", to_addr: "customer@example.com", subject: "Re: Hello there", body_text: "AI draft", body_html: null, sender_kind: "ai", message_id: null, created_at: new Date().toISOString() }],
      receptionist_audit_events: [],
    });
    const r = await approveDraft(db as never, "t-1", { id: "u1", email: "staff@zapnivo.com" });
    expect(r).toEqual({ ok: true, delivery: "queued" });
    expect(tables(db).receptionist_threads[0].status).toBe("awaiting_approval");
    expect(tables(db).receptionist_messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  it("auto-send at autonomy 2 keeps the draft and awaiting_approval when unconfirmed", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.RECEPTIONIST_AUTONOMY = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ category: "general", confidence: 0.95, priority: "normal", draft_reply: "Thanks!", escalate: false, escalation_reason: null }) } }],
    }), { status: 200 })));
    const db = fakeDb({});
    const r = await ingestGeneralMail(db as never, mail({ messageId: "<auto@x>" }));
    expect(r.status).toBe("accepted");
    const t = tables(db).receptionist_threads[0];
    expect(t.status).toBe("awaiting_approval"); // not "waiting"
    const msgs = tables(db).receptionist_messages;
    expect(msgs.some((m) => m.direction === "outbound")).toBe(false);
    expect(msgs.some((m) => m.direction === "draft")).toBe(true);
    expect(await repo.listEmails("queued")).toHaveLength(1);
  });
});

/* ── Monitored-address routing ────────────────────────────────────────────── */

describe("monitored recipient routing", () => {
  it("monitoredRecipient matches registry addresses, strips plus-tags, rejects unknowns", () => {
    expect(monitoredRecipient({ recipients: ["Security@Zapnivo.com"] })).toBe("security@zapnivo.com");
    expect(monitoredRecipient({ recipients: ["billing+anything@zapnivo.com"] })).toBe("billing+anything@zapnivo.com");
    expect(monitoredRecipient({ recipients: ["random@zapnivo.com"] })).toBeNull();
    expect(monitoredRecipient({ recipients: ["evil-support@zapnivo.com"] })).toBeNull();
    expect(monitoredRecipient({ recipients: ["person@example.com"] })).toBeNull();
  });

  it("routes security@ mail to the receptionist and preserves the recipient", async () => {
    const db = fakeDb({});
    const ctx = { repo: { getTicketByNumber: vi.fn(async () => null) } } as never;
    const out = await processInboundMail(ctx, db as never, {
      from: "reporter@example.com", subject: "Phishing email pretending to be Zapnivo", text: "I received a fake rental link, security concern",
      messageId: "<sec@x>", inReplyTo: null, recipients: ["security@zapnivo.com"], dmarc: null, spf: null, dkim: null,
    });
    expect(out.status).toBe("accepted");
    expect(tables(db).receptionist_threads).toHaveLength(1);
    const t = tables(db).receptionist_threads[0];
    expect(t.category).toBe("security"); // scam-report intent classifies sensibly
    expect(tables(db).receptionist_messages[0].to_addr).toBe("security@zapnivo.com");
  });

  it("routes support@ mail without a ticket credential to the receptionist instead of dropping it", async () => {
    const db = fakeDb({});
    const ctx = { repo: { getTicketByNumber: vi.fn(async () => null) } } as never;
    const out = await processInboundMail(ctx, db as never, {
      from: "person@example.com", subject: "no reference here", text: "hello",
      messageId: "<sup2@x>", inReplyTo: null, recipients: ["support@zapnivo.com"], dmarc: null, spf: null, dkim: null,
    });
    expect(out.status).toBe("accepted");
    expect(tables(db).receptionist_threads).toHaveLength(1);
  });

  it("still ignores mail to unregistered addresses", async () => {
    const db = fakeDb({});
    const ctx = { repo: { getTicketByNumber: vi.fn(async () => null) } } as never;
    const out = await processInboundMail(ctx, db as never, {
      from: "person@example.com", subject: "no reference here", text: "hello",
      messageId: "<unk@x>", inReplyTo: null, recipients: ["random@zapnivo.com"], dmarc: null, spf: null, dkim: null,
    });
    expect(out).toMatchObject({ status: "ignored", reason: "no_ticket_reference" });
    expect(tables(db).receptionist_threads ?? []).toHaveLength(0);
  });

  it("routes monitored mail even when the helpdesk ctx is unavailable", async () => {
    const db = fakeDb({});
    const out = await processInboundMail(null, db as never, {
      from: "person@example.com", subject: "billing question", text: "hello",
      messageId: "<noc@x>", inReplyTo: null, recipients: ["partners@zapnivo.com"], dmarc: null, spf: null, dkim: null,
    });
    expect(out.status).toBe("accepted");
    expect(tables(db).receptionist_threads).toHaveLength(1);
  });
});

/* ── Escalation staff alerts ──────────────────────────────────────────────── */

describe("staff alerting", () => {
  it("alertStaff queues one email per staff profile via the outbox", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    const db = fakeDb({ profiles: STAFF });
    const n = await alertStaff({ subject: "Test alert", body: "body", sender: "admin", event: "test.event" }, db as never);
    expect(n).toBe(2);
    const emails = await repo.listEmails("queued");
    expect(emails.map((e) => e.to).sort()).toEqual(["admin@zapnivo.com", "staff@zapnivo.com"]);
    expect(emails[0].event).toBe("test.event");
  });

  it("escalated and quarantined threads alert staff once per cooldown window", async () => {
    const repo = new MemoryRepo();
    setRepoForTests(repo);
    const db = fakeDb({ profiles: STAFF });

    // Two distinct quarantined (spam) threads → only the first alerts.
    await ingestGeneralMail(db as never, mail({ from: "a@x.com", subject: "Casino bonus", text: "viagra casino crypto forex", messageId: "<q1@x>", recipients: ["hello@zapnivo.com"] }));
    await ingestGeneralMail(db as never, mail({ from: "b@x.com", subject: "Weight loss pills", text: "viagra casino crypto forex", messageId: "<q2@x>", recipients: ["hello@zapnivo.com"] }));
    expect(tables(db).receptionist_threads).toHaveLength(2);
    expect((await repo.listEmails("queued")).filter((e) => e.event === "receptionist.escalation")).toHaveLength(2); // 1 alert × 2 staff

    // A different category (escalated refund) is a different cooldown key → alerts.
    await ingestGeneralMail(db as never, mail({ from: "c@x.com", subject: "Refund please", text: "I want my money back for rental Z-1", messageId: "<e1@x>", recipients: ["hello@zapnivo.com"] }));
    expect((await repo.listEmails("queued")).filter((e) => e.event === "receptionist.escalation")).toHaveLength(4);
  });
});

/* ── Outbox retry bounds ──────────────────────────────────────────────────── */

describe("outbox retry", () => {
  it("requeue decision respects age and attempt cap", () => {
    const now = Date.now();
    const old = new Date(now - 60 * 60_000).toISOString();
    const recent = new Date(now - 60_000).toISOString();
    expect(outboxRetryEligible(0, old, now)).toBe(true);
    expect(outboxRetryEligible(4, old, now)).toBe(true);
    expect(outboxRetryEligible(5, old, now)).toBe(false); // cap
    expect(outboxRetryEligible(0, recent, now)).toBe(false); // too fresh
    expect(outboxRetryEligible(null, old, now)).toBe(true);
  });

  it("requeueFailedOutbox is a no-op without Supabase", async () => {
    expect(await requeueFailedOutbox()).toBe(0);
  });
});
