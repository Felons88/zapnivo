import type { SupabaseClient } from "@supabase/supabase-js";
import { stripeCall, stripeConfigured, isStripeWebhookConfigured } from "@/lib/stripe";
import { stripeMode } from "@/lib/payments/readiness";
import { backendConfigured } from "@/lib/supabase";
import { smsConfigured } from "@/lib/sms";
import { assistantConfigured } from "@/lib/ai/openrouter";
import { scrub } from "@/lib/observability";
import {
  githubConfigured, parseGithubRepo, vercelConfigured,
  getGithubRepo, listVercelDeployments,
} from "@/lib/system/deploy-provider";

/**
 * Integration registry + credential metadata for the system console.
 *
 * Hard rules:
 *  - NEVER return secret values. Env vars reduce to booleans, names, and a
 *    coarse mode derived from key prefixes (same approach as
 *    src/lib/payments/readiness.ts).
 *  - Health checks are bounded (5s), read-only, and only call providers for
 *    which an API client already exists in this repo. Providers without a
 *    client/token are reported honestly as unconfigured / not_verified.
 */

export type IntegrationStatus = "operational" | "unconfigured" | "unknown" | "degraded";
export type HealthStatus = IntegrationStatus | "requires_credentials" | "not_verified";

export type IntegrationProvider = {
  id: string;
  name: string;
  category: "payments" | "data" | "messaging" | "ai" | "scm" | "hosting" | "hardware";
  purpose: string;
  /** Env var NAMES that gate this provider (values are never read into responses). */
  envVars: readonly string[];
  configured: () => boolean;
  /** Coarse mode derived from key prefixes / non-secret config only. */
  mode: () => string;
  /** Human-readable webhook/inbound-endpoint state, or null when not applicable. */
  webhook?: () => string | null;
};

const env = (name: string) => Boolean(process.env[name]);
const githubRepoLabel = () => {
  const r = parseGithubRepo();
  return r ? `${r.owner}/${r.repo}` : "none";
};

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    purpose: "Checkout sessions, manual-capture holds, refunds, disputes, billing webhooks.",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TAX_ENABLED"],
    configured: () => stripeConfigured(),
    mode: () => stripeMode(),
    webhook: () => (isStripeWebhookConfigured() ? "webhook signing secret set" : "webhook signing secret MISSING — events will fail verification"),
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "data",
    purpose: "Postgres database, auth, storage, realtime — service-role access for all server code.",
    envVars: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    configured: () => backendConfigured(),
    mode: () => (backendConfigured() ? "service_role" : "none"),
  },
  {
    id: "brevo",
    name: "Brevo transactional email",
    category: "messaging",
    purpose: "Primary outbound customer/staff email via the Brevo API (src/lib/helpdesk/mailer.ts prefers Brevo when BREVO_API_KEY is set).",
    envVars: ["BREVO_API_KEY", "SUPPORT_FROM_EMAIL"],
    configured: () => env("BREVO_API_KEY"),
    mode: () => "brevo",
    webhook: () => (env("EMAIL_INBOUND_SECRET") ? "inbound email webhook secret set" : "inbound email webhook NOT configured (EMAIL_INBOUND_SECRET missing)"),
  },
  {
    id: "resend",
    name: "Resend email (fallback)",
    category: "messaging",
    purpose: "Fallback mailer when BREVO_API_KEY is unset (src/lib/helpdesk/mailer.ts).",
    envVars: ["RESEND_API_KEY", "SUPPORT_FROM_EMAIL"],
    configured: () => env("RESEND_API_KEY"),
    mode: () => "resend",
    webhook: () => null,
  },
  {
    id: "twilio",
    name: "Twilio SMS",
    category: "messaging",
    purpose: "Outbound rental notifications + inbound SMS webhook (STOP/START opt-outs, delivery callbacks).",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    configured: () => smsConfigured(),
    mode: () => "live",
    webhook: () => "inbound SMS + delivery-status webhooks (sender-number ACL; no signing secret)",
  },
  {
    id: "openrouter",
    name: "OpenRouter (AI)",
    category: "ai",
    purpose: "Assistant/receptionist/triage chat completions (src/lib/ai/openrouter.ts).",
    envVars: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
    configured: () => assistantConfigured(),
    mode: () => process.env.OPENROUTER_MODEL ?? "unknown",
    webhook: () => null,
  },
  {
    id: "github",
    name: "GitHub",
    category: "scm",
    purpose: "Source control + deploy-trigger API (src/lib/system/deploy-provider.ts: deployments, commits, PRs, check runs).",
    envVars: ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_DEPLOY_REFS"],
    configured: () => githubConfigured(),
    mode: () => githubRepoLabel(),
    webhook: () => null,
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "hosting",
    purpose: "Hosting platform + deployments API (src/lib/system/deploy-provider.ts). Runtime env (VERCEL_ENV/URL/GIT_COMMIT_SHA) is platform-injected.",
    envVars: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_TEAM_ID"],
    configured: () => vercelConfigured(),
    mode: () => process.env.VERCEL_ENV ?? "none",
    webhook: () => null,
  },
  {
    id: "kiosk_gateway",
    name: "Kiosk gateway",
    category: "hardware",
    purpose: "Device event ingest at /api/devices/events + kiosk manifest/playback (Bearer KIOSK_INGEST_SECRET).",
    envVars: ["KIOSK_INGEST_SECRET"],
    configured: () => env("KIOSK_INGEST_SECRET"),
    mode: () => (env("KIOSK_INGEST_SECRET") ? "ingest_secret" : "none"),
    webhook: () => (env("KIOSK_INGEST_SECRET") ? "device ingest bearer configured" : null),
  },
  {
    id: "uptime",
    name: "Uptime & observability",
    category: "hosting",
    purpose: "Internal synthetic uptime probes (/api/cron/uptime → uptime_checks) and cron/alert telemetry — no external SaaS dependency.",
    envVars: ["CRON_SECRET"],
    configured: () => backendConfigured(),
    mode: () => "internal",
    webhook: () => (env("CRON_SECRET") ? "cron endpoints authorized via CRON_SECRET" : "CRON_SECRET missing — scheduled probes cannot authenticate"),
  },
];

export type EnvPresence = { name: string; set: boolean };

export type LastHealthCheck = {
  status: HealthStatus;
  checkedAt: string;
  latencyMs: number | null;
  /** Scrubbed, capped failure/ok detail from the last check (never secrets). */
  detail: string | null;
};

export type IntegrationRow = {
  id: string;
  name: string;
  category: IntegrationProvider["category"];
  purpose: string;
  envVars: readonly string[];
  /** Per-env-var presence — partial configuration is visible per credential. */
  envPresence: EnvPresence[];
  configured: boolean;
  mode: string;
  /** Webhook / inbound-endpoint state, or null when not applicable. */
  webhook: string | null;
  status: IntegrationStatus;
  /** Latest on-demand health check from audit (populated by listIntegrationStatus). */
  lastHealthCheck: LastHealthCheck | null;
};

/** Registry listing — env presence only, no live calls, no secret material. */
export function listIntegrations(): IntegrationRow[] {
  return INTEGRATION_PROVIDERS.map((p) => {
    const configured = p.configured();
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      purpose: p.purpose,
      envVars: p.envVars,
      envPresence: p.envVars.map((name) => ({ name, set: env(name) })),
      configured,
      mode: p.mode(),
      webhook: p.webhook ? p.webhook() : null,
      // Without a live check we can only claim 'unconfigured' or 'unknown'.
      status: configured ? "unknown" : "unconfigured",
      lastHealthCheck: null,
    };
  });
}

/**
 * Registry listing enriched with the LAST on-demand health check per provider,
 * recovered from system_audit_events (action 'integration.health_checked').
 * Best-effort: audit read failures leave lastHealthCheck null.
 */
export async function listIntegrationStatus(db: SupabaseClient | null): Promise<IntegrationRow[]> {
  const rows = listIntegrations();
  if (!db) return rows;
  try {
    const { data } = await db
      .from("system_audit_events")
      .select("resource,detail,created_at")
      .eq("action", "integration.health_checked")
      .order("created_at", { ascending: false })
      .limit(500);
    const latest = new Map<string, LastHealthCheck>();
    for (const r of (data ?? []) as { resource: string; detail: Record<string, unknown> | null; created_at: string }[]) {
      if (!r.resource.startsWith("integration:")) continue;
      const id = r.resource.slice("integration:".length);
      if (latest.has(id)) continue; // rows are newest-first
      const d = r.detail ?? {};
      const status = typeof d.status === "string" ? (d.status as HealthStatus) : "unknown";
      latest.set(id, {
        status,
        checkedAt: r.created_at,
        latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null,
        detail: typeof d.detail === "string" ? d.detail.slice(0, 200) : null,
      });
    }
    return rows.map((row) => ({ ...row, lastHealthCheck: latest.get(row.id) ?? null }));
  } catch {
    return rows;
  }
}

export function getProvider(id: string): IntegrationProvider | null {
  return INTEGRATION_PROVIDERS.find((p) => p.id === id) ?? null;
}

/* ── Bounded health checks ─────────────────────────────────────────────── */

const CHECK_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("health_check_timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t); });
}

export type HealthResult = {
  provider: string;
  status: HealthStatus;
  /** Human-readable, secret-free explanation of what was (and wasn't) verified. */
  detail: string;
  checkedAt: string;
  latencyMs: number | null;
};

const result = (provider: string, status: HealthStatus, detail: string, latencyMs: number | null): HealthResult => ({
  provider, status, detail, checkedAt: new Date().toISOString(), latencyMs,
});

async function timed(fn: () => Promise<{ ok: boolean; detail: string }>): Promise<HealthResult> {
  const start = performance.now();
  try {
    const r = await withTimeout(fn());
    const ms = Math.round(performance.now() - start);
    return result("", r.ok ? "operational" : "degraded", r.detail, ms);
  } catch (e) {
    const ms = Math.round(performance.now() - start);
    const msg = e instanceof Error ? e.message : "error";
    return result("", msg === "health_check_timeout" ? "unknown" : "degraded", `check failed: ${scrub(msg, 120)}`, ms);
  }
}

/**
 * Runs ONE bounded, read-only health check for a provider. Only performs a live
 * call where an API client/fetch pattern already exists in this repo; everything
 * else is reported honestly. Never throws.
 */
export async function checkIntegrationHealth(id: string, db: SupabaseClient | null): Promise<HealthResult | null> {
  const p = getProvider(id);
  if (!p) return null;
  const checkedAt = new Date().toISOString();
  const done = (status: HealthStatus, detail: string, latencyMs: number | null = null) =>
    result(id, status, detail, latencyMs);

  if (!p.configured()) {
    return done("unconfigured", `not configured — missing env: ${p.envVars.join(", ") || "(none required; no client token in use)"}`);
  }

  switch (id) {
    case "supabase": {
      if (!db) return done("unknown", "service client unavailable");
      const r = await timed(async () => {
        const { error } = await db.from("system_feature_flags").select("key", { count: "exact", head: true }).limit(1);
        return error ? { ok: false, detail: `db select failed: ${error.code ?? error.message}` } : { ok: true, detail: "select 1 on system_feature_flags succeeded" };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "stripe": {
      const webhook = isStripeWebhookConfigured() ? "webhook secret ✓" : "webhook secret ✗";
      const r = await timed(async () => {
        const res = await stripeCall<{ available?: unknown }>("GET", "/balance");
        return res.ok
          ? { ok: true, detail: `GET /v1/balance ok · mode ${stripeMode()} · ${webhook}` }
          : { ok: false, detail: `stripe ${res.status} ${res.code}: ${res.message}` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "brevo": {
      // Same endpoint/credential as src/lib/helpdesk/mailer.ts (Brevo branch).
      const r = await timed(async () => {
        const res = await fetch("https://api.brevo.com/v3/account", {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          headers: { "api-key": process.env.BREVO_API_KEY!, accept: "application/json" },
        });
        return res.ok
          ? { ok: true, detail: "GET /v3/account ok via brevo" }
          : { ok: false, detail: `brevo responded ${res.status}` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "resend": {
      const r = await timed(async () => {
        const res = await fetch("https://api.resend.com/domains", {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        });
        return res.ok
          ? { ok: true, detail: "GET /domains ok via resend" }
          : { ok: false, detail: `resend responded ${res.status}` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "twilio": {
      const sid = process.env.TWILIO_ACCOUNT_SID!;
      const r = await timed(async () => {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}` },
        });
        return res.ok
          ? { ok: true, detail: "GET account ok" }
          : { ok: false, detail: `twilio responded ${res.status}` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "openrouter": {
      const r = await timed(async () => {
        const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        });
        return res.ok
          ? { ok: true, detail: "GET /auth/key ok" }
          : { ok: false, detail: `openrouter responded ${res.status}` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "kiosk_gateway": {
      if (!db) return done("unknown", "service client unavailable — cannot check device_events");
      const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { count, error } = await db
        .from("device_events")
        .select("id", { count: "exact", head: true })
        .gte("occurred_at", dayAgo);
      if (error) return done("unknown", "device_events not queryable");
      const n = count ?? 0;
      return done(n > 0 ? "operational" : "unknown",
        n > 0 ? `${n} device event(s) in last 24h` : "ingest secret set but no device_events in last 24h (idle fleet or silent devices)");
    }
    case "github": {
      const r = await timed(async () => {
        const res = await getGithubRepo();
        if (!res.configured) return { ok: false, detail: "credentials incomplete" };
        if (!res.ok) return { ok: false, detail: `github api ${res.status}: ${scrub(res.error, 120)}` };
        return { ok: true, detail: `GET repo ${res.data.fullName ?? githubRepoLabel()} ok` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "vercel": {
      const r = await timed(async () => {
        const res = await listVercelDeployments(1);
        if (!res.configured) return { ok: false, detail: "credentials incomplete" };
        if (!res.ok) return { ok: false, detail: `vercel api ${res.status}: ${scrub(res.error, 120)}` };
        return { ok: true, detail: `GET deployments ok (project ${process.env.VERCEL_PROJECT_ID ? "set" : "unset"})` };
      });
      return { ...r, provider: id, checkedAt };
    }
    case "uptime": {
      if (!db) return done("unknown", "service client unavailable — cannot read uptime_checks");
      const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
      const { count, error } = await db
        .from("uptime_checks")
        .select("id", { count: "exact", head: true })
        .gte("checked_at", dayAgo);
      if (error) return done("unknown", "uptime_checks not queryable — run migrations / check cron");
      const n = count ?? 0;
      const cronAuth = env("CRON_SECRET") ? "CRON_SECRET set" : "CRON_SECRET MISSING";
      return done(n > 0 ? "operational" : "degraded",
        `${n} uptime probe(s) in last 24h · ${cronAuth}`);
    }
    default:
      return done("requires_credentials", "no verified API client for this provider — live check not performed");
  }
}

/* ── Credential metadata (secrets registry) ────────────────────────────── */

export type SecretMeta = {
  /** Owning integration id, or "platform" for cross-cutting secrets. */
  provider: string;
  envVar: string;
  purpose: string;
  /** Human rotation procedure — env writes are manual via the Vercel dashboard. */
  rotation: string;
  configured: () => boolean;
};

const has = (name: string) => () => Boolean(process.env[name]);

export const SECRET_REGISTRY: readonly SecretMeta[] = [
  { provider: "stripe", envVar: "STRIPE_SECRET_KEY", purpose: "Stripe API secret key (server-side payments)", rotation: "Stripe Dashboard → Developers → API keys → Roll key, then update STRIPE_SECRET_KEY in Vercel and redeploy. Old key stays valid until expired.", configured: has("STRIPE_SECRET_KEY") },
  { provider: "stripe", envVar: "STRIPE_WEBHOOK_SECRET", purpose: "Stripe webhook endpoint signing secret", rotation: "Stripe Dashboard → Developers → Webhooks → reveal/roll signing secret for the endpoint, update STRIPE_WEBHOOK_SECRET in Vercel and redeploy.", configured: has("STRIPE_WEBHOOK_SECRET") },
  { provider: "stripe", envVar: "STRIPE_TAX_ENABLED", purpose: "Feature flag: enable Stripe automatic tax", rotation: "Not a secret — set to \"1\" or unset in Vercel env; takes effect on next deploy.", configured: has("STRIPE_TAX_ENABLED") },
  { provider: "supabase", envVar: "NEXT_PUBLIC_SUPABASE_URL", purpose: "Supabase project URL", rotation: "Project is fixed; changing it means migrating projects — treat as infrastructure change, not routine rotation.", configured: has("NEXT_PUBLIC_SUPABASE_URL") },
  { provider: "supabase", envVar: "NEXT_PUBLIC_SUPABASE_ANON_KEY", purpose: "Supabase anon/publishable key (browser-safe by design)", rotation: "Supabase Dashboard → Project Settings → API → roll anon key; update Vercel env and redeploy.", configured: has("NEXT_PUBLIC_SUPABASE_ANON_KEY") },
  { provider: "supabase", envVar: "SUPABASE_SERVICE_ROLE_KEY", purpose: "Supabase service-role key — full DB access, server only", rotation: "Supabase Dashboard → Project Settings → API → roll service_role key; update Vercel env and redeploy immediately, then verify all server routes.", configured: has("SUPABASE_SERVICE_ROLE_KEY") },
  { provider: "brevo", envVar: "BREVO_API_KEY", purpose: "Brevo transactional email API key", rotation: "Brevo Dashboard → SMTP & API → API Keys → generate new key, update Vercel env, redeploy, revoke old key.", configured: has("BREVO_API_KEY") },
  { provider: "resend", envVar: "RESEND_API_KEY", purpose: "Resend API key (fallback mailer when BREVO_API_KEY unset)", rotation: "Resend Dashboard → API Keys → create new key, update Vercel env, redeploy, revoke old key.", configured: has("RESEND_API_KEY") },
  { provider: "platform", envVar: "SUPPORT_FROM_EMAIL", purpose: "Verified sender address for outbound mail (shared by Brevo + Resend)", rotation: "Not a secret — change only to another verified sender/domain; update Vercel env and redeploy.", configured: has("SUPPORT_FROM_EMAIL") },
  { provider: "twilio", envVar: "TWILIO_ACCOUNT_SID", purpose: "Twilio account SID", rotation: "SID identifies the account; rotation = migrate to a new Twilio account/subaccount, then update SID+token+number together.", configured: has("TWILIO_ACCOUNT_SID") },
  { provider: "twilio", envVar: "TWILIO_AUTH_TOKEN", purpose: "Twilio auth token (signs webhook callbacks)", rotation: "Twilio Console → Account → Auth Token → request secondary token, update Vercel env, redeploy, then promote/rollback per Twilio docs.", configured: has("TWILIO_AUTH_TOKEN") },
  { provider: "twilio", envVar: "TWILIO_FROM_NUMBER", purpose: "Twilio sender phone number", rotation: "Not a secret — change to another owned/verified number; update Vercel env and redeploy.", configured: has("TWILIO_FROM_NUMBER") },
  { provider: "openrouter", envVar: "OPENROUTER_API_KEY", purpose: "OpenRouter API key for AI assistants", rotation: "OpenRouter Dashboard → Keys → create new key with credit limit, update Vercel env, redeploy, revoke old key.", configured: has("OPENROUTER_API_KEY") },
  { provider: "openrouter", envVar: "OPENROUTER_MODEL", purpose: "Default chat model slug", rotation: "Not a secret — config value; update Vercel env and redeploy.", configured: has("OPENROUTER_MODEL") },
  { provider: "github", envVar: "GITHUB_TOKEN", purpose: "GitHub token for deploy-center API (deployments, commits, PRs, check runs)", rotation: "GitHub → Settings → Developer settings → Fine-grained tokens → issue new token scoped to the repo, update Vercel env, redeploy, revoke old token.", configured: has("GITHUB_TOKEN") },
  { provider: "github", envVar: "GITHUB_REPO", purpose: "GitHub repo slug owner/name used by deploy-center calls", rotation: "Not a secret — config value; update Vercel env and redeploy.", configured: has("GITHUB_REPO") },
  { provider: "vercel", envVar: "VERCEL_TOKEN", purpose: "Vercel API token for deploy-center API (deployments, events, promote)", rotation: "Vercel → Account Settings → Tokens → create new token scoped to the project/team, update Vercel env, redeploy, revoke old token.", configured: has("VERCEL_TOKEN") },
  { provider: "vercel", envVar: "VERCEL_PROJECT_ID", purpose: "Vercel project id gating deploy API calls", rotation: "Not a secret — config value from the Vercel project settings; update Vercel env and redeploy.", configured: has("VERCEL_PROJECT_ID") },
  { provider: "kiosk_gateway", envVar: "KIOSK_INGEST_SECRET", purpose: "Bearer secret for device event ingest + kiosk manifest/playback", rotation: "Generate a new random secret, update Vercel env AND provision it to every kiosk/gateway, redeploy — devices with the old secret will be rejected until updated.", configured: has("KIOSK_INGEST_SECRET") },
  { provider: "platform", envVar: "CRON_SECRET", purpose: "Bearer secret authorizing /api/cron/* jobs", rotation: "Generate a new random secret, update Vercel env and any external scheduler (cron-job.org/UptimeRobot) that calls the routes, redeploy.", configured: has("CRON_SECRET") },
  { provider: "platform", envVar: "HELPDESK_SECRET", purpose: "Signs customer helpdesk thread access tokens", rotation: "Generate a new random secret, update Vercel env, redeploy — outstanding customer magic links invalidate (they re-request access).", configured: has("HELPDESK_SECRET") },
  { provider: "platform", envVar: "EMAIL_INBOUND_SECRET", purpose: "Shared secret for inbound email webhook (Brevo)", rotation: "Generate a new random secret, update BOTH Vercel env and the Brevo inbound webhook config, redeploy.", configured: has("EMAIL_INBOUND_SECRET") },
  { provider: "platform", envVar: "ALERT_WEBHOOK_URL", purpose: "External alerting webhook (Slack/PagerDuty-style)", rotation: "Rotate the URL in the alerting provider dashboard, update Vercel env, redeploy.", configured: has("ALERT_WEBHOOK_URL") },
  { provider: "platform", envVar: "AUTH_ANCHOR_SECRET", purpose: "Secret anchoring auth/session flows", rotation: "Generate a new random secret, update Vercel env, redeploy — may sign out active sessions; coordinate with staff.", configured: has("AUTH_ANCHOR_SECRET") },
  { provider: "platform", envVar: "DEVICE_CREDENTIAL_KEK", purpose: "AES-256 key-encryption-key wrapping system_devices credential ciphertext (device-auth)", rotation: "Generate a new 32-byte KEK (64 hex chars). Set DEVICE_CREDENTIAL_KEK_PREVIOUS=<old>, DEVICE_CREDENTIAL_KEK=<new>, DEVICE_CREDENTIAL_KEK_VERSION=<new tag>, redeploy, run credential/reencrypt per device, then unset PREVIOUS. Runbook: /system/security/readiness.", configured: has("DEVICE_CREDENTIAL_KEK") },
  { provider: "platform", envVar: "DEVICE_CREDENTIAL_KEK_PREVIOUS", purpose: "Previous KEK kept only during rotation so staged ciphertexts still decrypt", rotation: "Unset once every device reports the new key_version in telemetry. Set only as part of the KEK rotation runbook (see DEVICE_CREDENTIAL_KEK).", configured: has("DEVICE_CREDENTIAL_KEK_PREVIOUS") },
];

/** env_var_name → metadata. This map IS the allowlist for rotation requests. */
export const SECRET_BY_ENV_VAR: ReadonlyMap<string, SecretMeta> = new Map(SECRET_REGISTRY.map((s) => [s.envVar, s]));

export type SecretRow = {
  provider: string;
  envVar: string;
  purpose: string;
  rotation: string;
  configured: boolean;
  /** Latest secret.rotation_requested audit timestamp, or null when never requested. */
  lastRotatedAt: string | null;
};

/** Credential metadata listing — names and booleans only, never values. */
export async function listSecrets(db: SupabaseClient | null): Promise<SecretRow[]> {
  const lastByVar = new Map<string, string>();
  if (db) {
    try {
      const { data } = await db
        .from("system_audit_events")
        .select("resource,created_at")
        .eq("action", "secret.rotation_requested")
        .order("created_at", { ascending: false })
        .limit(500);
      for (const r of (data ?? []) as { resource: string; created_at: string }[]) {
        // resource format: secret:{ENV_VAR_NAME}
        const name = r.resource.startsWith("secret:") ? r.resource.slice(7) : null;
        if (name && !lastByVar.has(name)) lastByVar.set(name, r.created_at);
      }
    } catch { /* audit read is best-effort */ }
  }
  return SECRET_REGISTRY.map((s) => ({
    provider: s.provider,
    envVar: s.envVar,
    purpose: s.purpose,
    rotation: s.rotation,
    configured: s.configured(),
    lastRotatedAt: lastByVar.get(s.envVar) ?? null,
  }));
}

/* ── Rotation request validation ───────────────────────────────────────── */

export type RotationCheck =
  | { ok: true; envVar: string; meta: SecretMeta }
  | { ok: false; error: string };

/**
 * Validates a rotation request: env var must be in the known registry
 * (SSRF/config-injection guard — arbitrary env names are rejected), and an
 * optional submitted value must look like a credential for that provider.
 * The value is NEVER stored or logged — it is only shape-checked.
 */
export function validateRotationRequest(input: { provider?: unknown; env_var_name?: unknown; new_value?: unknown }): RotationCheck {
  const envVar = typeof input.env_var_name === "string" ? input.env_var_name.trim() : "";
  const meta = SECRET_BY_ENV_VAR.get(envVar);
  if (!meta) {
    return { ok: false, error: `Unknown env var "${envVar.slice(0, 60)}" — not in the credential registry. Rotation requests are limited to known provider secrets.` };
  }
  if (input.provider !== undefined && input.provider !== meta.provider) {
    return { ok: false, error: `Env var ${envVar} belongs to provider "${meta.provider}", not "${String(input.provider).slice(0, 40)}".` };
  }
  const value = input.new_value;
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value !== "string") return { ok: false, error: "new_value must be a string" };
    if (value.length < 8 || value.length > 500) return { ok: false, error: "new_value length out of bounds (8–500 chars)" };
    if (/\s/.test(value)) return { ok: false, error: "new_value contains whitespace — not a valid credential shape" };
    const v = validateSecretShape(envVar, value);
    if (!v.ok) return v;
  }
  return { ok: true, envVar, meta };
}

/** Coarse per-provider shape checks. Advisory only — never blocks the manual step. */
function validateSecretShape(envVar: string, value: string): { ok: true } | { ok: false; error: string } {
  const prefixes: Record<string, RegExp> = {
    STRIPE_SECRET_KEY: /^sk_(live|test)_[A-Za-z0-9]{8,}$/,
    STRIPE_WEBHOOK_SECRET: /^whsec_[A-Za-z0-9]{8,}$/,
    RESEND_API_KEY: /^re_[A-Za-z0-9]{8,}$/,
    TWILIO_ACCOUNT_SID: /^AC[0-9a-fA-F]{32}$/,
    TWILIO_AUTH_TOKEN: /^[0-9a-fA-F]{32}$/,
    OPENROUTER_API_KEY: /^sk-or-[A-Za-z0-9_-]{8,}$/,
    KIOSK_INGEST_SECRET: /^[A-Za-z0-9_-]{16,}$/, // repo generates URL-safe random secrets
    CRON_SECRET: /^[A-Za-z0-9_-]{16,}$/,
    HELPDESK_SECRET: /^[A-Za-z0-9_-]{16,}$/,
    EMAIL_INBOUND_SECRET: /^[A-Za-z0-9_,\-]{8,}$/,
    AUTH_ANCHOR_SECRET: /^[A-Za-z0-9_-]{16,}$/,
  };
  const exact = prefixes[envVar];
  if (exact) return exact.test(value) ? { ok: true } : { ok: false, error: `Value does not match expected format for ${envVar} (${describeShape(envVar)}).` };
  // Known-but-unprefixed secrets (API keys without a fixed prefix): printable, no whitespace already enforced.
  return { ok: true };
}

function describeShape(envVar: string): string {
  const d: Record<string, string> = {
    STRIPE_SECRET_KEY: "sk_live_/sk_test_ + key material",
    STRIPE_WEBHOOK_SECRET: "whsec_ + secret",
    RESEND_API_KEY: "re_ + key",
    TWILIO_ACCOUNT_SID: "AC + 32 hex",
    TWILIO_AUTH_TOKEN: "32 hex chars",
    OPENROUTER_API_KEY: "sk-or-…",
    KIOSK_INGEST_SECRET: "16+ url-safe chars",
    CRON_SECRET: "16+ url-safe chars",
    HELPDESK_SECRET: "16+ url-safe chars",
    EMAIL_INBOUND_SECRET: "8+ url-safe chars (comma-separated allowed for rotation)",
    AUTH_ANCHOR_SECRET: "16+ url-safe chars",
  };
  return d[envVar] ?? "provider credential";
}
