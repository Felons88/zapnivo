import { beforeEach, describe, expect, it, vi } from "vitest";

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const { dbHolder, integHolder, readyHolder, kioskHolder, mailerHolder, bucketHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  integHolder: { rows: [] as Record<string, unknown>[] },
  readyHolder: { readiness: null as unknown },
  kioskHolder: { adapter: "none" },
  mailerHolder: { configured: false },
  bucketHolder: { ok: true },
}));

function createFakeDb(tables: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = { ...tables };
  const from = (table: string) => {
    const exists = table in store;
    const rows = store[table] ?? [];
    const st = {
      filters: [] as [string, unknown][],
      ins: [] as [string, unknown[]][],
      head: false,
      limitN: Number.POSITIVE_INFINITY,
    };
    const match = (r: Row) =>
      st.filters.every(([c, v]) => r[c] === v) && st.ins.every(([c, vs]) => vs.includes(r[c]));
    const exec = () => {
      if (!exists) return { data: null, error: { message: `relation ${table} does not exist` }, count: null };
      let out = rows.filter(match);
      if (st.limitN !== Number.POSITIVE_INFINITY) out = out.slice(0, st.limitN);
      if (st.head) return { data: null, error: null, count: out.length };
      return { data: out, error: null, count: out.length };
    };
    const b = {
      select: (_c?: unknown, opts?: { head?: boolean }) => { if (opts?.head) st.head = true; return b; },
      eq: (c: string, v: unknown) => { st.filters.push([c, v]); return b; },
      in: (c: string, vs: unknown[]) => { st.ins.push([c, vs]); return b; },
      order: () => b,
      limit: (n: number) => { st.limitN = n; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  };
  return {
    from,
    storage: {
      from: () => ({
        list: async () =>
          bucketHolder.ok ? { data: [], error: null } : { data: null, error: { message: "bucket not found" } },
      }),
    },
    _tables: store,
  };
}

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbHolder.db,
  backendConfigured: () => dbHolder.db !== null,
}));

vi.mock("@/lib/system/integrations", () => ({
  listIntegrationStatus: async () => integHolder.rows,
}));

vi.mock("@/lib/system/readiness", () => ({
  securityReadiness: async () => readyHolder.readiness,
}));

vi.mock("@/lib/system/kiosks", () => ({
  kioskAdapterName: () => kioskHolder.adapter,
}));

vi.mock("@/lib/helpdesk/mailer", () => ({
  mailerConfigured: () => mailerHolder.configured,
}));

vi.mock("@/lib/system/site-media", () => ({ MEDIA_BUCKET: "site-media" }));

vi.mock("@/lib/observability", () => ({
  recordLog: vi.fn(),
  reportError: vi.fn(),
  scrub: (s: string) => s,
  newTraceId: () => "t",
}));

import { getOpsStatus } from "@/lib/system/ops-status";

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const providerRow = (id: string, configured: boolean, hc: unknown = null) => ({
  id, name: id, category: "messaging", purpose: "", envVars: ["X_KEY"],
  envPresence: [], configured, mode: "test", webhook: null, status: "unknown",
  lastHealthCheck: hc,
});

const healthOk = { status: "operational", checkedAt: "2026-02-01T00:00:00Z", latencyMs: 12, detail: "ok" };
const healthBad = { status: "degraded", checkedAt: "2026-02-01T00:00:00Z", latencyMs: 12, detail: "boom" };

const baseReadiness = {
  configured: true,
  generated_at: "2026-02-01T00:00:00Z",
  backup: { state: "no_verified_backup", provider_snapshot: null },
};

beforeEach(() => {
  dbHolder.db = createFakeDb({
    newsletter_subscribers: [{ id: "s1" }],
    site_content: [{ id: "c1" }],
    site_redirects: [],
    site_media: [{ id: "m1" }],
    email_outbox: [{ id: "e1", status: "sent", event: "newsletter.confirm" }],
  });
  integHolder.rows = ["stripe", "brevo", "twilio", "openrouter", "github", "vercel"].map((id) =>
    providerRow(id, true, healthOk));
  readyHolder.readiness = baseReadiness;
  kioskHolder.adapter = "none";
  mailerHolder.configured = true;
  bucketHolder.ok = true;
});

const card = async (id: string) => {
  const s = await getOpsStatus(dbHolder.db as never);
  const c = s.cards.find((x) => x.id === id);
  expect(c, `card ${id} exists`).toBeTruthy();
  return c!;
};

describe("provider cards", () => {
  it("operational ONLY with configured + recorded operational health check", async () => {
    expect((await card("stripe")).state).toBe("operational");
    expect((await card("github")).verified).toBe(true);
  });

  it("configured but never checked → requires_action, never operational", async () => {
    integHolder.rows = ["stripe", "brevo", "twilio", "openrouter", "github", "vercel"].map((id) =>
      providerRow(id, true, null));
    const c = await card("vercel");
    expect(c.state).toBe("requires_action");
    expect(c.verified).toBeNull();
  });

  it("unconfigured → not_configured; degraded check → degraded", async () => {
    integHolder.rows = [
      providerRow("stripe", false), providerRow("brevo", true, healthBad),
      providerRow("twilio", true, healthOk), providerRow("openrouter", true, healthOk),
      providerRow("github", true, healthOk), providerRow("vercel", true, healthOk),
    ];
    expect((await card("stripe")).state).toBe("not_configured");
    expect((await card("brevo")).state).toBe("degraded");
  });
});

describe("newsletter card", () => {
  it("operational when mailer configured + subscribers table + sent DOI on record", async () => {
    const c = await card("newsletter");
    expect(c.state).toBe("operational");
    expect(c.configured).toBe(true);
    expect(c.href).toBe("/system/newsletter");
  });

  it("requires_action when no sent delivery exists yet", async () => {
    dbHolder.db = createFakeDb({ newsletter_subscribers: [{ id: "s1" }], email_outbox: [] });
    const c = await card("newsletter");
    expect(c.state).toBe("requires_action");
    expect(c.verified).toBe(false);
    expect(c.nextAction).toContain("test DOI");
  });

  it("requires_action when mail provider missing; degraded when table missing", async () => {
    mailerHolder.configured = false;
    expect((await card("newsletter")).state).toBe("requires_action");
    mailerHolder.configured = true;
    dbHolder.db = createFakeDb({}); // no newsletter_subscribers → probe null
    expect((await card("newsletter")).state).toBe("degraded");
    dbHolder.db = null;
    expect((await card("newsletter")).state).toBe("not_configured");
  });
});

describe("db-backed cards", () => {
  it("cms operational when site_content reachable; degraded when not", async () => {
    expect((await card("cms")).state).toBe("operational");
    dbHolder.db = createFakeDb({});
    expect((await card("cms")).state).toBe("degraded");
    dbHolder.db = null;
    expect((await card("cms")).state).toBe("not_configured");
  });

  it("redirects operational when table reachable (runtime reader in proxy); degraded when not", async () => {
    const c = await card("redirects");
    expect(c.state).toBe("operational"); // src/lib/site-redirects.ts is consumed by src/proxy.ts
    dbHolder.db = createFakeDb({});
    expect((await card("redirects")).state).toBe("degraded");
  });

  it("media degraded when bucket probe fails", async () => {
    bucketHolder.ok = false;
    expect((await card("media")).state).toBe("degraded");
    bucketHolder.ok = true;
    expect((await card("media")).state).toBe("operational");
  });
});

describe("recovery + kiosk cards", () => {
  it("maps backup state machine honestly", async () => {
    readyHolder.readiness = { ...baseReadiness, backup: { state: "no_verified_backup", provider_snapshot: null } };
    expect((await card("recovery")).state).toBe("blocked");
    readyHolder.readiness = { ...baseReadiness, backup: { state: "restore_tested", provider_snapshot: null } };
    expect((await card("recovery")).state).toBe("operational");
    readyHolder.readiness = { ...baseReadiness, backup: { state: "backup_available", provider_snapshot: null } };
    expect((await card("recovery")).state).toBe("requires_action");
  });

  it("kiosk adapter none → blocked; configured → requires_action (never operational)", async () => {
    expect((await card("kiosk_adapter")).state).toBe("blocked");
    kioskHolder.adapter = "simulator";
    const c = await card("kiosk_adapter");
    expect(c.state).toBe("requires_action");
    expect(c.verified).toBe(false);
  });
});

describe("shape", () => {
  it("every card has valid href, implemented flag, and ISO lastChecked", async () => {
    const s = await getOpsStatus(dbHolder.db as never);
    expect(s.cards.length).toBeGreaterThanOrEqual(12);
    for (const c of s.cards) {
      expect(c.href).toMatch(/^\/system\//);
      expect(c.implemented).toBe(true);
      expect(c.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (c.state === "operational") expect(c.verified).toBe(true);
    }
  });
});
