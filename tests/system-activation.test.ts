import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activationProbe } from "@/lib/system/activation";

/**
 * Activation probe shape + honesty rules:
 *  - envConfigured reflects required-env presence only.
 *  - credentialVerified is TRUE only with a recorded 'operational'
 *    integration.health_checked audit row — never from env presence.
 *  - newsletter-mail is always present and borrows mailer-leg evidence.
 *  - No secret values anywhere in the output.
 */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(queue: Result[] = []) {
  const q = [...queue];
  const next = (): Result => (q.length ? q.shift()! : { data: null, error: null });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) b[m] = () => b;
  b.maybeSingle = async () => next();
  b.single = async () => next();
  b.then = (res: (v: Result) => unknown) => Promise.resolve(next()).then(res);
  return b;
}

const fakeDb = (auditQueue: Result[]) => {
  // ONE shared table: both probe queries hit system_audit_events and consume
  // the queue FIFO (health-checked rows first, then recent activity rows).
  const t = fakeTable(auditQueue);
  return { from: () => t } as unknown as SupabaseClient;
};

/* NOTE: activationProbe issues exactly TWO queries against
   system_audit_events, in order:
     1. listIntegrationStatus  → action='integration.health_checked' rows
     2. recentAuditRows        → recent activity rows
   The fake table serves them from one FIFO queue. */

const ENV_KEYS = [
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  "BREVO_API_KEY", "RESEND_API_KEY", "SUPPORT_FROM_EMAIL", "EMAIL_INBOUND_SECRET",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "OPENROUTER_API_KEY",
  "GITHUB_TOKEN", "GITHUB_REPO",
  "VERCEL_TOKEN", "VERCEL_PROJECT_ID",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "KIOSK_INGEST_SECRET",
  "CRON_SECRET", "ALERT_WEBHOOK_URL",
  "NEXT_PUBLIC_GTM_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_MAPBOX_TOKEN",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PROVIDER_IDS = [
  "stripe", "brevo", "resend", "twilio", "openrouter",
  "github", "vercel", "supabase", "kiosk-gateway",
  "uptime", "alerts", "analytics", "newsletter-mail",
];

describe("activationProbe — shape", () => {
  it("returns all 13 required providers with the documented fields", async () => {
    const probe = await activationProbe(fakeDb([{ data: [], error: null }, { data: [], error: null }]));
    expect(probe.providers.map((p) => p.provider)).toEqual(PROVIDER_IDS);
    for (const p of probe.providers) {
      expect(Object.keys(p).sort()).toEqual(
        ["provider", "name", "envConfigured", "missing", "credentialVerified", "verifiedAt",
         "verification", "webhookConfigured", "webhookNote", "lastOperation", "ownerAction"].sort(),
      );
      expect(typeof p.envConfigured).toBe("boolean");
      expect(typeof p.credentialVerified).toBe("boolean");
      expect(Array.isArray(p.missing)).toBe(true);
      expect(p.missing.every((m) => /^[A-Z0-9_]+$/.test(m))).toBe(true);
      expect(p.ownerAction.length).toBeGreaterThan(10);
    }
    expect(probe.summary.total).toBe(13);
  });

  it("clean env: nothing envConfigured, nothing verified, honest missing lists", async () => {
    const probe = await activationProbe(fakeDb([{ data: [], error: null }, { data: [], error: null }]));
    for (const p of probe.providers) {
      expect(p.envConfigured).toBe(false);
      expect(p.credentialVerified).toBe(false);
      expect(p.verifiedAt).toBeNull();
      expect(p.verification).toContain("no live health check");
      expect(p.missing.length).toBeGreaterThan(0);
    }
    const stripe = probe.providers.find((p) => p.provider === "stripe")!;
    expect(stripe.missing).toEqual(["STRIPE_SECRET_KEY"]);
    expect(stripe.webhookConfigured).toBe(false); // STRIPE_WEBHOOK_SECRET unset
    const nl = probe.providers.find((p) => p.provider === "newsletter-mail")!;
    expect(nl.missing).toEqual(["BREVO_API_KEY", "RESEND_API_KEY"]);
    const alerts = probe.providers.find((p) => p.provider === "alerts")!;
    expect(alerts.missing).toEqual(["ALERT_WEBHOOK_URL"]);
    const analytics = probe.providers.find((p) => p.provider === "analytics")!;
    expect(analytics.missing).toEqual(["NEXT_PUBLIC_GTM_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_MAPBOX_TOKEN"]);
    const uptime = probe.providers.find((p) => p.provider === "uptime")!;
    expect(uptime.missing).toEqual(["CRON_SECRET"]);
  });
});

describe("activationProbe — verification honesty", () => {
  it("env presence alone NEVER marks a provider verified", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.BREVO_API_KEY = "xkeysib-fake";
    const probe = await activationProbe(fakeDb([{ data: [], error: null }, { data: [], error: null }]));
    const stripe = probe.providers.find((p) => p.provider === "stripe")!;
    expect(stripe.envConfigured).toBe(true);
    expect(stripe.credentialVerified).toBe(false);
    expect(stripe.verification).toContain("no live health check");
    expect(stripe.ownerAction).toContain("unverified");
  });

  it("a recorded 'operational' health check verifies the provider with timestamp", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
    const healthRows = [
      { resource: "integration:stripe", detail: { status: "operational", latencyMs: 123, detail: "GET /v1/balance ok" }, created_at: "2026-01-01T00:00:00Z" },
    ];
    const activityRows = [
      { action: "stripe.refund.issued", resource: "payment:abc", created_at: "2026-01-02T00:00:00Z" },
    ];
    const probe = await activationProbe(fakeDb([{ data: healthRows, error: null }, { data: activityRows, error: null }]));
    const stripe = probe.providers.find((p) => p.provider === "stripe")!;
    expect(stripe.credentialVerified).toBe(true);
    expect(stripe.verifiedAt).toBe("2026-01-01T00:00:00Z");
    expect(stripe.verification).toContain("operational");
    expect(stripe.webhookConfigured).toBe(true);
    expect(stripe.lastOperation?.action).toBe("stripe.refund.issued");
    expect(stripe.ownerAction).toContain("Activated");
  });

  it("a degraded last check does NOT verify", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfake";
    process.env.TWILIO_AUTH_TOKEN = "fake";
    process.env.TWILIO_FROM_NUMBER = "+15550001111";
    const healthRows = [
      { resource: "integration:twilio", detail: { status: "degraded", latencyMs: 5000, detail: "check failed" }, created_at: "2026-01-01T00:00:00Z" },
    ];
    const probe = await activationProbe(fakeDb([{ data: healthRows, error: null }, { data: [], error: null }]));
    const twilio = probe.providers.find((p) => p.provider === "twilio")!;
    expect(twilio.envConfigured).toBe(true);
    expect(twilio.credentialVerified).toBe(false);
    expect(twilio.verification).toContain("degraded");
    // webhook rides on credentials for twilio (sender-number ACL)
    expect(twilio.webhookConfigured).toBe(true);
  });

  it("newsletter-mail activates on either mailer key and borrows leg verification", async () => {
    process.env.RESEND_API_KEY = "re_fake";
    const healthRows = [
      { resource: "integration:resend", detail: { status: "operational", latencyMs: 80 }, created_at: "2026-01-03T00:00:00Z" },
    ];
    const probe = await activationProbe(fakeDb([{ data: healthRows, error: null }, { data: [], error: null }]));
    const nl = probe.providers.find((p) => p.provider === "newsletter-mail")!;
    expect(nl.envConfigured).toBe(true);
    expect(nl.missing).toEqual([]);
    expect(nl.credentialVerified).toBe(true);
    expect(nl.verifiedAt).toBe("2026-01-03T00:00:00Z");
  });

  it("db=null still returns the full matrix with honest nulls", async () => {
    const probe = await activationProbe(null);
    expect(probe.providers).toHaveLength(13);
    expect(probe.providers.every((p) => p.lastOperation === null)).toBe(true);
    expect(probe.providers.every((p) => p.credentialVerified === false)).toBe(true);
  });
});
