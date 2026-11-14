import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAlertPayload, notifyAlert, notifyIssueAlert, sendTestAlert,
  getAlertDeliveryStatus, alertWebhookUrls,
} from "@/lib/system/alert-notify";

/* ── Tiny table stub: captures inserts, serves seeded rows for selects ── */

type Row = Record<string, unknown>;
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }
    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ id: `n${rows.length + 1}`, created_at: new Date().toISOString(), ...item });
        return { data: items, error: null };
      }
      let out = rows.filter(match);
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    single() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return Promise.resolve({ data: rows[0] ?? null, error: rows.length ? null : { message: "0 rows" } });
    }
    maybeSingle() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }
  return { from: (t: string) => new QB(t), _tables: tables } as unknown as SupabaseClient & { _tables: Record<string, Row[]> };
}

const actor = { id: "11111111-1111-4111-8111-111111111111", role: "sysadmin" };
const WEBHOOK = "https://hooks.example.com/services/T000/B000/XXXX";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALERT_WEBHOOK_URL;
});

describe("buildAlertPayload — sanitization", () => {
  it("strips emails, phones, secrets and restricts links to /system/ paths", () => {
    const p = buildAlertPayload({
      fingerprint: "issue:abc123",
      severity: "critical",
      title: "Error: contact admin@example.com or +1 555-123-4567 token=sk-abcdef123456",
      body: "card 4111 1111 1111 1111 bearer eyJhbGciOiJIUzI1NiJ9.x",
      link: "https://evil.example.com/steal?token=abc",
    });
    const blob = JSON.stringify(p);
    expect(blob).not.toContain("admin@example.com");
    expect(blob).not.toContain("555-123-4567");
    expect(blob).not.toContain("4111 1111 1111 1111");
    expect(blob).not.toContain("sk-abcdef123456");
    expect(blob).not.toContain("evil.example.com");
    expect(p.zapnivo.link).toBeNull();
    expect(p.zapnivo.severity).toBe("critical");
  });

  it("keeps safe internal links and marks test payloads", () => {
    const p = buildAlertPayload({
      fingerprint: "test-alert:x", severity: "info",
      title: "t", link: "/system/observability/alerts", test: true,
    });
    expect(p.zapnivo.link).toBe("/system/observability/alerts");
    expect(p.zapnivo.test).toBe(true);
    expect(p.text).toContain("(TEST)");
  });
});

describe("notifyAlert", () => {
  it("returns sent:false + records 'skipped' when ALERT_WEBHOOK_URL is unset", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const db = fakeDb({ alert_notifications: [] });
    const res = await notifyAlert(db, { fingerprint: "issue:fp1", severity: "warning", title: "t" });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.sent).toBe(false); expect(res.configured).toBe(false); }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db._tables.alert_notifications[0].status).toBe("skipped");
    expect(db._tables.alert_notifications[0].detail).toContain("not configured");
  });

  it("dedupes on a recent 'sent' ledger row (no post, no new row)", async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    const recent = new Date().toISOString();
    const db = fakeDb({
      alert_notifications: [{ fingerprint: "issue:fp2", status: "sent", sent_at: recent, created_at: recent }],
    });
    const res = await notifyAlert(db, { fingerprint: "issue:fp2", severity: "warning", title: "t" });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.sent).toBe(false); expect(res.deduped).toBe(true); }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db._tables.alert_notifications).toHaveLength(1);
  });

  it("posts a sanitized payload and records 'sent' when configured", async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    const db = fakeDb({ alert_notifications: [] });
    const res = await notifyAlert(db, {
      fingerprint: "issue:fp3", severity: "critical", title: "New critical",
      body: "mail me at ops@example.com", link: "/system/observability/errors",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse(String(init.body));
    expect(body.zapnivo.key).toBe("issue:fp3");
    expect(body.zapnivo.link).toBe("/system/observability/errors");
    expect(JSON.stringify(body)).not.toContain("ops@example.com");
    const row = db._tables.alert_notifications[0];
    expect(row.status).toBe("sent");
    expect(row.kind).toBe("alert");
    expect(row.sent_at).toBeTruthy();
  });

  it("post:false records delivery without POSTing (reportError seam)", async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    const db = fakeDb({ alert_notifications: [] });
    await notifyIssueAlert(db, { fingerprint: "deadbeef", severity: "warning", title: "Warn", culprit: "/api/x" });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = db._tables.alert_notifications[0];
    expect(row.status).toBe("sent");
    expect(row.detail).toBe("delivered via external_alert");
    expect(row.fingerprint).toBe("issue:deadbeef");
  });

  it("records 'failed' when the webhook rejects", async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const db = fakeDb({ alert_notifications: [] });
    const res = await notifyAlert(db, { fingerprint: "issue:fp4", severity: "warning", title: "t" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sent).toBe(false);
    expect(db._tables.alert_notifications[0].status).toBe("failed");
  });
});

describe("sendTestAlert", () => {
  it("fails honestly when no webhook is configured", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const db = fakeDb({ alert_notifications: [], system_audit_events: [] });
    const res = await sendTestAlert(db, actor);
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a marked test payload, records kind=test, and audits", async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    const db = fakeDb({ alert_notifications: [], system_audit_events: [] });
    const res = await sendTestAlert(db, actor);
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.configured).toBe(true); expect(res.delivered).toBe(true); }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.zapnivo.test).toBe(true);
    expect(body.zapnivo.severity).toBe("info");
    const row = db._tables.alert_notifications[0];
    expect(row.kind).toBe("test");
    expect(row.status).toBe("sent");
    expect(db._tables.system_audit_events.at(-1)!.action).toBe("observability.alert_test");
  });
});

describe("getAlertDeliveryStatus", () => {
  it("reports unconfigured + empty store honestly", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const db = fakeDb({ alert_notifications: [] });
    const s = await getAlertDeliveryStatus(db);
    expect(s.configured).toBe(false);
    expect(s.storeAvailable).toBe(true);
    expect(s.sent24h).toBe(0);
    expect(s.lastSentAt).toBeNull();
  });

  it("returns null-db base and tolerates a missing table", async () => {
    const s0 = await getAlertDeliveryStatus(null);
    expect(s0.configured).toBe(false);
    expect(s0.storeAvailable).toBe(false);
    // table that errors on select → storeAvailable stays false, no throw
    const badDb = { from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }) }) }) }) } as unknown as SupabaseClient;
    const s1 = await getAlertDeliveryStatus(badDb);
    expect(s1.storeAvailable).toBe(false);
    expect(s1.recent).toEqual([]);
  });
});
