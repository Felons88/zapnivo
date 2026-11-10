import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleInboundSms, isOptedOut, isTransactionalKind, normalizePhone, sendSms, smsOptCommand,
  OPT_OUT_CONFIRMATION, RESUBSCRIBE_CONFIRMATION,
} from "../src/lib/sms";
import { DEFAULT_TEMPLATES, interpolate, previewTemplate, queueJob, SMS_JOB_KINDS, SMS_SCHEDULE } from "../src/lib/notifications";

/* ── minimal chainable Supabase fake: records ops, returns canned rows ── */

type Rec = { table: string; op: string; payload?: unknown; onConflict?: string; filters: Record<string, unknown> };

function makeDb(single: Record<string, unknown> = {}, lists: Record<string, unknown[]> = {}) {
  const calls: Rec[] = [];
  const db: any = {
    from(table: string) {
      const rec: Rec = { table, op: "select", filters: {} };
      calls.push(rec);
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { rec.filters[k] = v; return q; },
        in: () => q, lte: () => q, gt: () => q, gte: () => q, not: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => {
          const row = single[table] as Record<string, unknown> | null;
          // honor .eq("phone", …) so opt-out lookups miss correctly in tests
          const miss = row && typeof row === "object" && "phone" in row && rec.filters.phone !== undefined && row.phone !== rec.filters.phone;
          return { data: miss ? null : (row ?? null), error: null };
        },
        single: async () => ({ data: single[table] ?? null, error: null }),
        insert: async (p: unknown) => { rec.op = "insert"; rec.payload = p; return { error: null }; },
        upsert: async (p: unknown, o?: { onConflict?: string }) => { rec.op = "upsert"; rec.payload = p; rec.onConflict = o?.onConflict; return { error: null }; },
        update: (p: unknown) => { rec.op = "update"; rec.payload = p; return q; },
        delete: () => { rec.op = "delete"; return q; },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: lists[table] ?? [], error: null }).then(res),
      };
      return q;
    },
  };
  return { db, calls };
}

const find = (calls: Rec[], table: string, op: string) => calls.filter((c) => c.table === table && c.op === op);

const TWILIO_ENV: Record<string, string> = {
  TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+15550001111",
};
const stubTwilioEnv = () => { for (const [k, v] of Object.entries(TWILIO_ENV)) vi.stubEnv(k, v); };

function stubTwilioOk() {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({ sid: "SM123", status: "queued" }), { status: 201 }));
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("phone + opt-command parsing", () => {
  it("normalizes US numbers to E.164", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("15551234567")).toBe("+15551234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("abc")).toBeNull();
  });
  it("detects STOP-family keywords whole-message or leading, case-insensitive", () => {
    for (const b of ["STOP", "stop.", "Stop please", "UNSUBSCRIBE", "cancel", "END", "quit now", "  StopAll "]) {
      expect(smsOptCommand(b), b).toBe("opt_out");
    }
    for (const b of ["START", "start again", "UNSTOP"]) expect(smsOptCommand(b), b).toBe("opt_in");
    // leading keyword counts even with trailing words (carrier behavior)
    expect(smsOptCommand("stop by the office")).toBe("opt_out");
    for (const b of ["hello", "I want to stop texting", "please stop", ""]) expect(smsOptCommand(b), b).toBeNull();
  });
});

describe("sendSms opt-out gating", () => {
  it("suppresses non-transactional kinds for opted-out phones without calling Twilio", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db, calls } = makeDb({ sms_opt_outs: { phone: "+15551234567" } });
    const res = await sendSms(db, { to: "5551234567", body: "hi", kind: "reminder_1h" });
    expect(res).toMatchObject({ sent: false, reason: "opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find(calls, "sms_messages", "insert")).toHaveLength(0); // suppressed sends aren't logged as outbound
  });
  it("still sends transactional kinds to opted-out phones", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = makeDb({ sms_opt_outs: { phone: "+15551234567" } });
    const res = await sendSms(db, { to: "5551234567", body: "fee notice", kind: "non_return_fee_charged" });
    expect(res.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(isTransactionalKind("non_return_fee_charged")).toBe(true);
    expect(isTransactionalKind("reminder_1h")).toBe(false);
  });
  it("treats kind-less sends as non-transactional", async () => {
    stubTwilioEnv();
    vi.stubGlobal("fetch", stubTwilioOk());
    const { db } = makeDb({ sms_opt_outs: { phone: "+15551234567" } });
    expect((await sendSms(db, { to: "5551234567", body: "hi" })).sent).toBe(false);
  });
  it("captures Twilio error code/message on failed sends", async () => {
    stubTwilioEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 21610, message: "Attempt to send to unsubscribed recipient" }), { status: 400 }),
    ));
    const { db, calls } = makeDb();
    const res = await sendSms(db, { to: "5551234567", body: "hi", kind: "payment_failed" });
    expect(res).toMatchObject({ sent: false, errorCode: "21610" });
    const row = find(calls, "sms_messages", "insert")[0].payload as Record<string, unknown>;
    expect(row).toMatchObject({ status: "failed", error_code: "21610", direction: "outbound" });
    expect(row.error_message).toContain("unsubscribed");
  });
  it("isOptedOut normalizes and misses cleanly", async () => {
    stubTwilioEnv();
    const { db } = makeDb({ sms_opt_outs: { phone: "+15551234567" } });
    expect(await isOptedOut(db, "(555) 123-4567")).toBe(true);
    expect(await isOptedOut(db, "5559999999")).toBe(false);
    expect(await isOptedOut(null, "5551234567")).toBe(false);
  });
});

describe("inbound opt-out flow (handleInboundSms)", () => {
  const inbound = { from: "+15551234567", to: "+15550001111", body: "STOP", sid: "SMin1" };

  it("STOP records the inbound row, upserts the opt-out, sends ONE confirmation", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db, calls } = makeDb(); // not previously opted out
    const r = await handleInboundSms(db, inbound);
    expect(r).toEqual({ action: "opted_out", confirmed: true });
    const inb = find(calls, "sms_messages", "insert").map((c) => c.payload as Record<string, unknown>);
    expect(inb.some((p) => p.direction === "inbound" && p.status === "received")).toBe(true);
    expect(find(calls, "sms_opt_outs", "upsert")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const sentBody = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("Body");
    expect(sentBody).toBe(OPT_OUT_CONFIRMATION);
    expect(sentBody).toContain("Reply START to resubscribe");
  });

  it("a repeated STOP does not resend the confirmation", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db, calls } = makeDb({ sms_opt_outs: { phone: "+15551234567" } });
    const r = await handleInboundSms(db, { ...inbound, sid: "SMin2" });
    expect(r).toEqual({ action: "opted_out", confirmed: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(find(calls, "sms_opt_outs", "upsert")).toHaveLength(0);
    expect(find(calls, "sms_messages", "insert").length).toBeGreaterThan(0); // still logged
  });

  it("START removes the opt-out and sends a resubscribe confirmation", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db, calls } = makeDb();
    const r = await handleInboundSms(db, { ...inbound, body: "start", sid: "SMin3" });
    expect(r).toEqual({ action: "opted_in" });
    expect(find(calls, "sms_opt_outs", "delete")).toHaveLength(1);
    const sentBody = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get("Body");
    expect(sentBody).toBe(RESUBSCRIBE_CONFIRMATION);
  });

  it("non-keyword inbound gets the auto-ack; media gets none", async () => {
    stubTwilioEnv();
    const fetchMock = stubTwilioOk();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = makeDb();
    await handleInboundSms(db, { ...inbound, body: "where is my charger?", sid: "SMin4" });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();
    await handleInboundSms(db, { ...inbound, body: "", sid: "SMin5", hasMedia: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("job kinds, templates & dedupe", () => {
  it("every job kind has a default template and scheduled kinds are a subset", () => {
    for (const k of SMS_JOB_KINDS) expect(DEFAULT_TEMPLATES[k], k).toBeTruthy();
    for (const s of SMS_SCHEDULE) expect(SMS_JOB_KINDS).toContain(s.kind);
    for (const k of ["return_failed", "non_return_fee_charged", "payment_failed", "ticket_received"]) {
      expect(SMS_JOB_KINDS).toContain(k);
      expect(isTransactionalKind(k)).toBe(true);
    }
  });
  it("templates interpolate cleanly with sample vars — no leftover placeholders", () => {
    for (const [kind, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
      const out = previewTemplate(tpl);
      expect(out, kind).not.toMatch(/\{[a-z_]+\}/);
      expect(out.length).toBeLessThanOrEqual(480);
    }
    // interpolate still neutralizes brace injection
    expect(interpolate("{ref}", { ref: "{fee}" })).toBe("fee");
  });
  it("queueJob dedupes rental jobs on (rental_id,kind) and ticket jobs on (ticket_id,kind)", async () => {
    const { db: dbR, calls: cR } = makeDb();
    await queueJob(dbR, { kind: "payment_failed", rentalId: "r1" });
    const r1 = find(cR, "notification_jobs", "upsert")[0];
    expect(r1.onConflict).toBe("rental_id,kind");
    expect((r1.payload as Record<string, unknown>).rental_id).toBe("r1");

    const { db: dbT, calls: cT } = makeDb();
    await queueJob(dbT, { kind: "ticket_received", ticketId: "t1" });
    const t1 = find(cT, "notification_jobs", "upsert")[0];
    expect(t1.onConflict).toBe("ticket_id,kind");
    expect((t1.payload as Record<string, unknown>).rental_id).toBeNull();
    expect((t1.payload as Record<string, unknown>).ticket_id).toBe("t1");
    expect((t1.payload as Record<string, unknown>).status).toBe("queued");
  });
});
