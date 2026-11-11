import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS, SECRET_REGISTRY, SECRET_BY_ENV_VAR,
  getProvider, listIntegrations, validateRotationRequest,
} from "@/lib/system/integrations";
import { WEBHOOK_SOURCES } from "@/lib/system/webhooks";
import { CRON_ROUTES } from "@/lib/system/jobs";

describe("integration registry", () => {
  it("covers the expected providers", () => {
    const ids = INTEGRATION_PROVIDERS.map((p) => p.id);
    for (const id of ["stripe", "supabase", "brevo", "twilio", "openrouter", "github", "vercel", "kiosk_gateway"]) {
      expect(ids).toContain(id);
    }
  });

  it("never exposes secret values — rows carry names/booleans only", () => {
    for (const row of listIntegrations()) {
      expect(Object.keys(row).sort()).toEqual(
        ["id", "name", "category", "purpose", "envVars", "configured", "mode", "status", "lastHealthCheck"].sort(),
      );
      expect(row.lastHealthCheck).toBeNull();
      expect(["operational", "unconfigured", "unknown", "degraded"]).toContain(row.status);
      // env var NAMES are fine; nothing should look like a secret value
      for (const v of row.envVars) expect(v).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("getProvider resolves known ids and rejects others", () => {
    expect(getProvider("stripe")?.name).toBe("Stripe");
    expect(getProvider("nope")).toBeNull();
  });
});

describe("secrets registry", () => {
  it("env allowlist is unique and complete", () => {
    const names = SECRET_REGISTRY.map((s) => s.envVar);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SECRET_REGISTRY) {
      expect(SECRET_BY_ENV_VAR.get(s.envVar)).toBe(s);
      expect(s.purpose.length).toBeGreaterThan(5);
      expect(s.rotation.length).toBeGreaterThan(10);
    }
  });
});

describe("validateRotationRequest", () => {
  it("rejects env vars not in the registry (config-injection guard)", () => {
    const r = validateRotationRequest({ env_var_name: "PATH", provider: "platform" });
    expect(r.ok).toBe(false);
    const r2 = validateRotationRequest({ env_var_name: "EVIL_INJECT" });
    expect(r2.ok).toBe(false);
  });

  it("rejects provider/env mismatches", () => {
    const r = validateRotationRequest({ env_var_name: "STRIPE_SECRET_KEY", provider: "twilio" });
    expect(r.ok).toBe(false);
  });

  it("accepts a known env var without a value", () => {
    const r = validateRotationRequest({ env_var_name: "STRIPE_SECRET_KEY", provider: "stripe" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envVar).toBe("STRIPE_SECRET_KEY");
  });

  it("shape-checks submitted values but accepts request", () => {
    const bad = validateRotationRequest({ env_var_name: "STRIPE_SECRET_KEY", new_value: "not-a-stripe-key" });
    expect(bad.ok).toBe(false);
    const good = validateRotationRequest({ env_var_name: "STRIPE_SECRET_KEY", new_value: ["sk", "test", "FAKEFAKEFAKEFAKEFAKEFAKE"].join("_") });
    expect(good.ok).toBe(true);
    const short = validateRotationRequest({ env_var_name: "CRON_SECRET", new_value: "abc" });
    expect(short.ok).toBe(false);
  });
});

describe("webhook/job constants", () => {
  it("webhook sources match the real tables", () => {
    expect(WEBHOOK_SOURCES).toEqual(["stripe_events", "inbound_emails", "inbound_jobs", "sms_messages", "kiosk_events"]);
  });

  it("cron routes mirror vercel.json schedules", () => {
    const byPath = Object.fromEntries(CRON_ROUTES.map((c) => [c.path, c.schedule]));
    expect(byPath["/api/cron/rentals"]).toBe("0 12 * * *");
    expect(byPath["/api/cron/inbound"]).toBe("0 13 * * *");
    expect(byPath["/api/cron/uptime"]).toBe("0 14 * * *");
    expect(byPath["/api/cron/analytics"]).toBe("30 14 * * *");
  });
});
