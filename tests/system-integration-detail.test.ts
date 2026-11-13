import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getIntegrationDetail } from "@/lib/system/integration-detail";
import { getProvider, INTEGRATION_PROVIDERS } from "@/lib/system/integrations";

/**
 * Detail-assembly tests: env presence/missing accuracy, verified-vs-configured
 * distinction, webhook state mapping, last-operation timestamps, and the
 * no-secrets invariant. DB is a chainable fake keyed by table name.
 */

const ENV_KEYS = [
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TAX_ENABLED",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "BREVO_API_KEY", "RESEND_API_KEY", "SUPPORT_FROM_EMAIL", "EMAIL_INBOUND_SECRET",
  "RESEND_WEBHOOK_SECRET", "BREVO_WEBHOOK_SECRET",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
  "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS",
  "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID",
  "KIOSK_INGEST_SECRET", "CRON_SECRET",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

/* ── Chainable fake Supabase client ────────────────────────────────────── */

type Query = {
  table: string;
  cols: unknown;
  head: boolean;
  filters: unknown[][];
};
type Handler = (q: Query) => { data?: unknown; error?: { message: string } | null; count?: number | null };

function fakeDb(handlers: Record<string, Handler>): SupabaseClient {
  const calls: Query[] = [];
  const from = (table: string) => {
    const q: Query = { table, cols: null, head: false, filters: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    b.select = (cols?: unknown, opts?: { count?: string; head?: boolean }) => {
      q.cols = cols;
      q.head = opts?.head === true;
      return b;
    };
    for (const m of ["order", "limit", "neq", "not", "is", "lt", "lte", "gt", "filter"]) {
      b[m] = () => b;
    }
    for (const m of ["eq", "in", "gte"]) {
      b[m] = (...a: unknown[]) => { q.filters.push([m, ...a]); return b; };
    }
    const resolve = () => {
      calls.push(q);
      const h = handlers[table];
      return h ? h(q) : { data: null, error: null, count: 0 };
    };
    b.maybeSingle = async () => {
      const r = resolve();
      return { data: r.data ?? null, error: r.error ?? null };
    };
    b.single = b.maybeSingle;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(res, rej);
    return b;
  };
  return { from, _calls: calls } as unknown as SupabaseClient & { _calls: Query[] };
}

const T1 = "2025-06-01T10:00:00.000Z";
const T2 = "2025-06-02T10:00:00.000Z";

/* ── Tests ─────────────────────────────────────────────────────────────── */

describe("getIntegrationDetail — unknown ids", () => {
  it("returns null for unknown provider", async () => {
    expect(await getIntegrationDetail(null, "nope")).toBeNull();
  });

  it("covers every registered provider", async () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(getProvider(p.id)).not.toBeNull();
      const d = await getIntegrationDetail(null, p.id);
      expect(d, p.id).not.toBeNull();
      expect(d!.provider.id).toBe(p.id);
    }
  });
});

describe("read vs write authorization honesty", () => {
  it("read auth is 'not_run' with no health check evidence", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_12345678";
    const d = await getIntegrationDetail(fakeDb({}), "stripe");
    expect(d!.readAuth.status).toBe("not_run");
    // configured env does NOT imply verified
    expect(d!.provider.configured).toBe(true);
  });

  it("read auth is 'verified' only from an operational health check", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_12345678";
    const db = fakeDb({
      system_audit_events: () => ({
        data: { detail: { status: "operational", latencyMs: 87, detail: "GET /v1/balance ok" }, created_at: T1 },
        error: null,
      }),
    });
    const d = await getIntegrationDetail(db, "stripe");
    expect(d!.readAuth.status).toBe("verified");
    expect(d!.readAuth.checkedAt).toBe(T1);
    expect(d!.readAuth.latencyMs).toBe(87);
  });

  it("read auth is 'failed' on degraded check, 'unverified' on inconclusive", async () => {
    process.env.BREVO_API_KEY = "x".repeat(20);
    const degraded = fakeDb({
      system_audit_events: () => ({ data: { detail: { status: "degraded", detail: "brevo 401" }, created_at: T1 }, error: null }),
    });
    expect((await getIntegrationDetail(degraded, "brevo"))!.readAuth.status).toBe("failed");
    const unknown = fakeDb({
      system_audit_events: () => ({ data: { detail: { status: "unknown", detail: "timeout" }, created_at: T1 }, error: null }),
    });
    expect((await getIntegrationDetail(unknown, "brevo"))!.readAuth.status).toBe("unverified");
  });

  it("write auth: github is 'none', stripe/vercel are 'unverified'", async () => {
    const gh = await getIntegrationDetail(null, "github");
    expect(gh!.writeAuth.status).toBe("none");
    process.env.STRIPE_SECRET_KEY = "sk_test_12345678";
    const st = await getIntegrationDetail(null, "stripe");
    expect(st!.writeAuth.status).toBe("unverified");
    const vc = await getIntegrationDetail(null, "vercel");
    expect(vc!.writeAuth.status).toBe("unverified");
  });
});

describe("env presence / missing settings", () => {
  it("reports exact missing required env var names", async () => {
    const d = await getIntegrationDetail(null, "twilio");
    expect(d!.missingSettings).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]);
    process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32);
    const d2 = await getIntegrationDetail(null, "twilio");
    expect(d2!.missingSettings).toEqual(["TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]);
  });

  it("distinguishes required vs optional missing", async () => {
    process.env.GITHUB_TOKEN = "ghp_" + "a".repeat(20);
    process.env.GITHUB_REPO = "o/r";
    const d = await getIntegrationDetail(null, "github");
    expect(d!.missingSettings).toEqual([]);
    expect(d!.optionalMissing).toContain("GITHUB_DEPLOY_REFS");
  });

  it("env presence booleans mirror provider.envVars", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_12345678";
    const d = await getIntegrationDetail(null, "stripe");
    const byName = Object.fromEntries(d!.provider.envPresence.map((e) => [e.name, e.set]));
    expect(byName.STRIPE_SECRET_KEY).toBe(true);
    expect(byName.STRIPE_WEBHOOK_SECRET).toBe(false);
    expect(byName.STRIPE_TAX_ENABLED).toBe(false);
  });
});

describe("webhook state mapping", () => {
  it("stripe webhook: secret presence + last event from stripe_events", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_12345678";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_" + "b".repeat(20);
    const db = fakeDb({
      stripe_events: () => ({ data: { received_at: T2 }, error: null }),
    });
    const d = await getIntegrationDetail(db, "stripe");
    expect(d!.webhook.applicable).toBe(true);
    expect(d!.webhook.endpoint).toBe("/api/webhooks/stripe");
    expect(d!.webhook.secretEnv).toBe("STRIPE_WEBHOOK_SECRET");
    expect(d!.webhook.secretSet).toBe(true);
    expect(d!.webhook.lastEventAt).toBe(T2);
    expect(d!.webhook.lastSuccessAt).toBe(T2);
  });

  it("kiosk webhook reports rejected count and ok-signal separately", async () => {
    process.env.KIOSK_INGEST_SECRET = "s".repeat(24);
    const db = fakeDb({
      system_device_messages: (q) =>
        q.head
          ? { count: 4, error: null }
          : q.filters.some((f) => f[0] === "eq" && f[1] === "result" && f[2] === "ok")
            ? { data: { received_at: T1 }, error: null }
            : { data: { received_at: T2 }, error: null },
    });
    const d = await getIntegrationDetail(db, "kiosk_gateway");
    expect(d!.webhook.secretSet).toBe(true);
    expect(d!.webhook.lastSuccessAt).toBe(T1);
    expect(d!.webhook.lastEventAt).toBe(T2);
    expect(d!.webhook.failures24h).toBe(4);
  });

  it("providers without inbound webhooks report applicable=false", async () => {
    const d = await getIntegrationDetail(null, "openrouter");
    expect(d!.webhook.applicable).toBe(false);
    expect(d!.webhook.endpoint).toBeNull();
  });

  it("twilio webhook has no dedicated secret env (signature auth)", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32);
    process.env.TWILIO_AUTH_TOKEN = "a".repeat(32);
    process.env.TWILIO_FROM_NUMBER = "+15551234567";
    const d = await getIntegrationDetail(fakeDb({}), "twilio");
    expect(d!.webhook.applicable).toBe(true);
    expect(d!.webhook.secretEnv).toBeNull();
    expect(d!.webhook.secretSet).toBeNull();
  });
});

describe("last successful operation", () => {
  it("reads the provider-relevant table timestamp", async () => {
    const db = fakeDb({
      email_outbox: () => ({ data: { created_at: T1 }, error: null }),
    });
    process.env.BREVO_API_KEY = "x".repeat(20);
    const d = await getIntegrationDetail(db, "brevo");
    expect(d!.lastOperation?.table).toBe("email_outbox");
    expect(d!.lastOperation?.at).toBe(T1);
  });

  it("openrouter uses ai_agent_runs ok status", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-" + "c".repeat(20);
    const db = fakeDb({
      ai_agent_runs: () => ({ data: { created_at: T2 }, error: null }),
    });
    const d = await getIntegrationDetail(db, "openrouter");
    expect(d!.lastOperation?.table).toBe("ai_agent_runs");
    expect(d!.lastOperation?.at).toBe(T2);
  });

  it("github/vercel have no discrete op signal", async () => {
    expect((await getIntegrationDetail(null, "github"))!.lastOperation).toBeNull();
    expect((await getIntegrationDetail(null, "vercel"))!.lastOperation).toBeNull();
  });
});

describe("guidance + secrets metadata", () => {
  it("every provider has permissions text, action checklist, and docs URLs valid", async () => {
    for (const p of INTEGRATION_PROVIDERS) {
      const d = await getIntegrationDetail(null, p.id);
      expect(d!.requiredPermissions.length).toBeGreaterThan(10);
      expect(d!.requiredAction.length).toBeGreaterThan(0);
      for (const doc of d!.docs) {
        expect(doc.url).toMatch(/^https:\/\//);
        expect(doc.label.length).toBeGreaterThan(3);
      }
    }
  });

  it("secrets list carries names/purposes only — never values", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_SUPERSECRET_VALUE_123";
    const d = await getIntegrationDetail(null, "stripe");
    const json = JSON.stringify(d);
    expect(json).not.toContain("SUPERSECRET_VALUE_123");
    expect(d!.secrets.length).toBeGreaterThan(0);
    for (const s of d!.secrets) {
      expect(s.envVar).toMatch(/^[A-Z0-9_]+$/);
      expect(s.purpose.length).toBeGreaterThan(5);
      expect(s.rotation.length).toBeGreaterThan(10);
    }
  });

  it("uptime surfaces CRON_SECRET in secrets metadata", async () => {
    const d = await getIntegrationDetail(null, "uptime");
    expect(d!.secrets.some((s) => s.envVar === "CRON_SECRET")).toBe(true);
  });
});
