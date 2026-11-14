import type { SupabaseClient } from "@supabase/supabase-js";
import { listIntegrationStatus, type IntegrationRow } from "./integrations";
import { mailerConfigured } from "@/lib/helpdesk/mailer";

/**
 * Activation probe for GET /api/system/activation.
 *
 * Answers "which external providers are actually ready to carry production
 * traffic?" per provider:
 *
 *  - envConfigured      — every REQUIRED env var for the provider is present
 *                         (presence only; values are never read).
 *  - credentialVerified — TRUE only when a real health check on record came
 *                         back 'operational' (latest integration.health_checked
 *                         audit row written by checkIntegrationHealth). Env
 *                         presence alone NEVER counts as verified.
 *  - webhookConfigured  — webhook/inbound endpoint secret presence, or null
 *                         when the provider has no inbound webhook.
 *  - lastOperation      — newest system_audit_events row matching the
 *                         provider's action/resource pattern (best-effort;
 *                         null when nothing on record).
 *  - missing / ownerAction — exact next step for a human operator.
 *
 * Reuses listIntegrationStatus() — the same rows /system/integrations shows —
 * and adds the 'newsletter-mail' provider (outbound newsletter delivery runs
 * through the shared mailer: Brevo primary, Resend fallback) which has no
 * INTEGRATION_PROVIDERS entry of its own.
 */

export type ActivationProvider = {
  provider: string;
  name: string;
  envConfigured: boolean;
  /** Required env var NAMES that are absent (values never appear). */
  missing: string[];
  credentialVerified: boolean;
  /** ISO timestamp of the health check that proved verification, else null. */
  verifiedAt: string | null;
  /** What the verification evidence actually says — honest either way. */
  verification: string;
  /** true/false when a webhook exists, null when not applicable. */
  webhookConfigured: boolean | null;
  webhookNote: string | null;
  /** Newest matching audit row, or null when nothing is on record. */
  lastOperation: { at: string; action: string; resource: string } | null;
  ownerAction: string;
};

export type ActivationProbe = {
  generated_at: string;
  providers: ActivationProvider[];
  summary: {
    total: number;
    envConfigured: number;
    credentialVerified: number;
    webhookReady: number;
  };
};

type ProviderSpec = {
  provider: string;
  name: string;
  /** Id in INTEGRATION_PROVIDERS whose row supplies health/env evidence. */
  integrationId?: string;
  /** Env vars that must ALL be present for envConfigured. */
  requiredEnv?: readonly string[];
  /** Any-of env vars (newsletter-mail: Brevo OR Resend activates the mailer). */
  anyOfEnv?: readonly string[];
  /** Custom envConfigured override (e.g. mailerConfigured semantics). */
  envConfiguredFn?: () => boolean;
  webhookEnv?: string;
  webhookNote?: string | null;
  /** Webhook exists but is authorized by provider credentials, not a secret. */
  webhookViaCredentials?: boolean;
  /** Regex tested against "action resource" of recent audit rows. */
  activityPattern: RegExp;
  healthRoute?: string;
  /**
   * Overrides the generic "run a live check" hint when no healthRoute exists —
   * used for providers whose evidence is operational (public client config,
   * delivery receipts) rather than a probeable credential.
   */
  verifyHint?: string;
};

const SPECS: readonly ProviderSpec[] = [
  {
    provider: "stripe",
    name: "Stripe",
    integrationId: "stripe",
    requiredEnv: ["STRIPE_SECRET_KEY"],
    webhookEnv: "STRIPE_WEBHOOK_SECRET",
    webhookNote: "POST /api/webhooks/stripe signature verification",
    activityPattern: /stripe|payment|billing|refund|dispute|checkout|invoice|payout/i,
    healthRoute: "/api/system/integrations/stripe/health",
  },
  {
    provider: "brevo",
    name: "Brevo transactional email",
    integrationId: "brevo",
    requiredEnv: ["BREVO_API_KEY"],
    webhookEnv: "EMAIL_INBOUND_SECRET",
    webhookNote: "POST /api/webhooks/email/inbound (Brevo inbound → support tickets)",
    activityPattern: /email|brevo|outbox|inbound|mailer|mail\./i,
    healthRoute: "/api/system/integrations/brevo/health",
  },
  {
    provider: "resend",
    name: "Resend email (fallback)",
    integrationId: "resend",
    requiredEnv: ["RESEND_API_KEY"],
    webhookNote: null,
    activityPattern: /email|resend|outbox|inbound|mailer|mail\./i,
    healthRoute: "/api/system/integrations/resend/health",
  },
  {
    provider: "twilio",
    name: "Twilio SMS",
    integrationId: "twilio",
    requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    webhookViaCredentials: true,
    webhookNote: "inbound SMS + delivery-status callbacks authorized by sender-number ACL (no signing secret)",
    activityPattern: /sms|twilio/i,
    healthRoute: "/api/system/integrations/twilio/health",
  },
  {
    provider: "openrouter",
    name: "OpenRouter (AI)",
    integrationId: "openrouter",
    requiredEnv: ["OPENROUTER_API_KEY"],
    activityPattern: /openrouter|assistant|receptionist|triage|ai\./i,
    healthRoute: "/api/system/integrations/openrouter/health",
  },
  {
    provider: "github",
    name: "GitHub",
    integrationId: "github",
    requiredEnv: ["GITHUB_TOKEN", "GITHUB_REPO"],
    activityPattern: /github|deploy|commit|pull_request|check_run/i,
    healthRoute: "/api/system/integrations/github/health",
  },
  {
    provider: "vercel",
    name: "Vercel",
    integrationId: "vercel",
    requiredEnv: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
    activityPattern: /vercel|deploy|release|promotion/i,
    healthRoute: "/api/system/integrations/vercel/health",
  },
  {
    provider: "supabase",
    name: "Supabase",
    integrationId: "supabase",
    requiredEnv: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    activityPattern: /migration|database|schema|backup|recovery|supabase/i,
    healthRoute: "/api/system/integrations/supabase/health",
  },
  {
    provider: "kiosk-gateway",
    name: "Kiosk gateway",
    integrationId: "kiosk_gateway",
    requiredEnv: ["KIOSK_INGEST_SECRET"],
    webhookNote: "device ingest at /api/devices/events uses Bearer KIOSK_INGEST_SECRET (same secret as API auth)",
    activityPattern: /kiosk|device|ingest|hardware|command/i,
    healthRoute: "/api/system/integrations/kiosk_gateway/health",
  },
  {
    provider: "uptime",
    name: "Uptime probes & cron auth",
    integrationId: "uptime",
    requiredEnv: ["CRON_SECRET"],
    webhookNote: "scheduled probes authenticate with CRON_SECRET bearer — no inbound provider webhook",
    activityPattern: /uptime|cron|probe|scheduler/i,
    healthRoute: "/api/system/integrations/uptime/health",
  },
  {
    provider: "alerts",
    name: "Alerting webhook",
    integrationId: "alerts",
    requiredEnv: ["ALERT_WEBHOOK_URL"],
    webhookNote: "outbound-only push alerts — ALERT_WEBHOOK_URL receives POSTs; no inbound surface",
    activityPattern: /alert|incident|error_issue|observability|external_alert/i,
    healthRoute: "/api/system/integrations/alerts/health",
  },
  {
    provider: "analytics",
    name: "Analytics & maps (public)",
    integrationId: "analytics",
    anyOfEnv: ["NEXT_PUBLIC_GTM_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID", "NEXT_PUBLIC_MAPBOX_TOKEN"],
    webhookNote: null,
    activityPattern: /analytics|gtm|ga4|mapbox|tag.?manager/i,
    // No healthRoute: the check honestly returns 'unknown' — public client
    // config has no server-side probe. verifyHint says where evidence lives.
    verifyHint: "confirm the container/measurement/map fires in the browser (GTM Preview, GA4 Realtime, map render) — public client config has no server-side probe",
  },
  {
    provider: "newsletter-mail",
    name: "Newsletter outbound mail",
    // No INTEGRATION_PROVIDERS row — newsletter delivery reuses the shared
    // helpdesk mailer (Brevo primary, Resend fallback). Verified evidence is
    // borrowed from the brevo/resend health checks.
    anyOfEnv: ["BREVO_API_KEY", "RESEND_API_KEY"],
    envConfiguredFn: mailerConfigured,
    activityPattern: /newsletter/i,
    healthRoute: undefined,
  },
];

const env = (name: string) => Boolean(process.env[name]);

/** Newest audit rows, scanned once and matched per provider. */
async function recentAuditRows(
  db: SupabaseClient | null,
): Promise<{ action: string; resource: string; created_at: string }[]> {
  if (!db) return [];
  try {
    const { data, error } = await db
      .from("system_audit_events")
      .select("action,resource,created_at")
      .order("created_at", { ascending: false })
      .limit(400);
    if (error || !Array.isArray(data)) return [];
    return (data as { action?: unknown; resource?: unknown; created_at?: unknown }[])
      .filter((r) => typeof r.action === "string" && typeof r.created_at === "string")
      .map((r) => ({ action: r.action as string, resource: typeof r.resource === "string" ? r.resource : "", created_at: r.created_at as string }));
  } catch {
    return [];
  }
}

function missingFor(spec: ProviderSpec): string[] {
  // Any-of semantics (envConfiguredFn or bare anyOfEnv): report the full
  // candidate set when none is set, empty when at least one is present.
  if (spec.envConfiguredFn || spec.anyOfEnv) {
    const candidates = spec.anyOfEnv ?? [];
    const set = candidates.filter(env);
    return set.length > 0 ? [] : [...candidates];
  }
  const required = spec.requiredEnv ?? [];
  return required.filter((name) => !env(name));
}

function envConfiguredFor(spec: ProviderSpec, row: IntegrationRow | undefined): boolean {
  if (spec.envConfiguredFn) return spec.envConfiguredFn();
  const required = spec.requiredEnv ?? [];
  if (required.length === 0) return row?.configured ?? false;
  return required.every(env);
}

function webhookFor(spec: ProviderSpec, envOk: boolean): { configured: boolean | null; note: string | null } {
  if (spec.webhookEnv) {
    const set = env(spec.webhookEnv);
    return { configured: set, note: spec.webhookNote ?? null };
  }
  if (spec.webhookViaCredentials) {
    return { configured: envOk, note: spec.webhookNote ?? null };
  }
  if (spec.webhookNote) {
    // Informational webhook state carried on the integration row.
    return { configured: null, note: spec.webhookNote };
  }
  return { configured: null, note: null };
}

function ownerActionFor(
  spec: ProviderSpec,
  missing: string[],
  envOk: boolean,
  verified: boolean,
  webhook: { configured: boolean | null; note: string | null },
): string {
  if (missing.length > 0) {
    return `Set ${missing.join(", ")} in the deployment environment and redeploy — presence is verified on the next request.`;
  }
  if (!verified) {
    const how = spec.healthRoute
      ? `run a live check via ${spec.healthRoute} (system.integrations.manage)`
      : (spec.verifyHint ?? "confirm delivery via the newsletter overview / a real send");
    return `Credentials are present but unverified — ${how}; 'operational' is required before this provider counts as activated.`;
  }
  if (webhook.configured === false && spec.webhookEnv) {
    return `Credentials verified but the inbound webhook is not: set ${spec.webhookEnv} and redeploy.`;
  }
  return "Activated — credentials verified by a recorded health check. Monitor drift on /system/integrations.";
}

/** Builds the per-provider activation matrix. Never throws; db may be null. */
export async function activationProbe(db: SupabaseClient | null): Promise<ActivationProbe> {
  const rows = await listIntegrationStatus(db);
  const byId = new Map<string, IntegrationRow>(rows.map((r) => [r.id, r]));
  const auditRows = await recentAuditRows(db);

  const providers: ActivationProvider[] = SPECS.map((spec) => {
    const row = spec.integrationId ? byId.get(spec.integrationId) : undefined;
    // newsletter-mail borrows verification evidence from whichever mailer leg
    // (brevo primary / resend fallback) has the NEWEST recorded health check.
    let evidenceRow = row;
    if (spec.provider === "newsletter-mail") {
      const legs = [byId.get("brevo"), byId.get("resend")].filter(
        (r): r is IntegrationRow => !!r?.lastHealthCheck,
      );
      legs.sort((a, b) => (b.lastHealthCheck?.checkedAt ?? "").localeCompare(a.lastHealthCheck?.checkedAt ?? ""));
      evidenceRow = legs[0];
    }

    const missing = missingFor(spec);
    const envOk = envConfiguredFor(spec, row);
    const hc = evidenceRow?.lastHealthCheck ?? null;
    const verified = hc?.status === "operational";
    const verification = hc
      ? verified
        ? `verified: health check 'operational' at ${hc.checkedAt}${hc.detail ? ` — ${hc.detail}` : ""}`
        : `not verified: last health check '${hc.status}' at ${hc.checkedAt}${hc.detail ? ` — ${hc.detail}` : ""}`
      : "not verified: no live health check on record — env presence is not verification";

    const hit = auditRows.find((r) => spec.activityPattern.test(`${r.action} ${r.resource}`)) ?? null;
    const webhook = webhookFor(spec, envOk);

    return {
      provider: spec.provider,
      name: spec.name,
      envConfigured: envOk,
      missing,
      credentialVerified: verified,
      verifiedAt: verified ? hc!.checkedAt : null,
      verification,
      webhookConfigured: webhook.configured,
      webhookNote: webhook.note,
      lastOperation: hit ? { at: hit.created_at, action: hit.action, resource: hit.resource } : null,
      ownerAction: ownerActionFor(spec, missing, envOk, verified, webhook),
    };
  });

  return {
    generated_at: new Date().toISOString(),
    providers,
    summary: {
      total: providers.length,
      envConfigured: providers.filter((p) => p.envConfigured).length,
      credentialVerified: providers.filter((p) => p.credentialVerified).length,
      webhookReady: providers.filter((p) => p.webhookConfigured === true).length,
    },
  };
}
