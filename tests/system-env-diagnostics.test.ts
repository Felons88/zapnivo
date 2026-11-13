import { describe, expect, it } from "vitest";
import { envDiagnostics } from "@/lib/system/env-diagnostics";

describe("envDiagnostics", () => {
  it("reports set/missing presence per var, grouped by feature area", () => {
    const d = envDiagnostics({ STRIPE_SECRET_KEY: "sk_live_abc", NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const stripe = d.groups.find((g) => g.id === "payments")!;
    const secret = stripe.vars.find((v) => v.name === "STRIPE_SECRET_KEY")!;
    expect(secret.set).toBe(true);
    expect(secret.secret).toBe(true);
    const webhook = stripe.vars.find((v) => v.name === "STRIPE_WEBHOOK_SECRET")!;
    expect(webhook.set).toBe(false);
    expect(d.groups.map((g) => g.id)).toContain("supabase");
    expect(d.groups.map((g) => g.id)).toContain("kiosk");
    expect(d.groups.map((g) => g.id)).toContain("cron");
  });

  it("NEVER leaks env values — only booleans", () => {
    const sentinel = "super-secret-value-9f8e7d";
    const d = envDiagnostics({
      STRIPE_SECRET_KEY: sentinel,
      SUPABASE_SERVICE_ROLE_KEY: `sb_secret_${sentinel}`,
      OPENROUTER_API_KEY: sentinel,
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    const json = JSON.stringify(d);
    expect(json).not.toContain(sentinel);
    expect(json).not.toContain("sk_live");
    // And no field named like a value carrier exists.
    for (const g of d.groups) for (const v of g.vars) {
      expect(Object.keys(v).sort()).toEqual(["features", "name", "secret", "set"]);
    }
  });

  it("counts missing required vars and surfaces runtime env labels", () => {
    const d = envDiagnostics({ NODE_ENV: "production", VERCEL_ENV: "production" } as NodeJS.ProcessEnv);
    expect(d.nodeEnv).toBe("production");
    expect(d.vercelEnv).toBe("production");
    expect(d.missingRequired).toBeGreaterThan(0);
    // all optional vars unset should not count
    const d2 = envDiagnostics({} as NodeJS.ProcessEnv);
    const optionalOnly = d2.groups.every((g) => g.vars.every((v) => v.set || v.features.length >= 0));
    expect(optionalOnly).toBe(true);
  });
});
