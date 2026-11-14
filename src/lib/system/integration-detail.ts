import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getProvider, listIntegrations,
  SECRET_REGISTRY,
  type IntegrationRow, type LastHealthCheck, type SecretMeta,
} from "@/lib/system/integrations";
import { cachedProviderVerification } from "@/lib/system/deploy-verify";
import type { DeployProviderId } from "@/lib/system/deploy-verify";
import { kioskAdapterName } from "@/lib/system/kiosks";
import { getGatewayAdapter } from "@/lib/kiosk/gateway-adapter";
import { parseGithubRepo } from "@/lib/system/deploy-provider";

/**
 * Per-provider operational detail for /system/integrations and
 * GET /api/system/integrations/[id]/detail.
 *
 * Hard rules (same as integrations.ts):
 *  - NEVER return secret values — env vars reduce to names + presence booleans.
 *  - 'verified' read/write states are ONLY set from real evidence: a recorded
 *    health check, a cached deploy-provider verification, or provider event
 *    rows. Configuration presence alone never claims verification.
 *  - All DB reads are bounded (limit 1 / head counts) and whitelisted to
 *    non-PII columns (timestamps, statuses, counts — never bodies/addresses).
 */

export type ReadAuthStatus = "verified" | "failed" | "unverified" | "not_run";
export type WriteAuthStatus = "none" | "unverified" | "proven";

export type WebhookDetail = {
  applicable: boolean;
  /** Public route path that receives provider callbacks. */
  endpoint: string | null;
  /** Env var that authenticates inbound events (null = no signing secret / ACL-based). */
  secretEnv: string | null;
  /** Presence of secretEnv; null when there is no dedicated secret. */
  secretSet: boolean | null;
  /** Short human description of the inbound surface. */
  description: string | null;
  /** Latest inbound event timestamp from the source table (null = none recorded / n/a). */
  lastEventAt: string | null;
  /** Latest successfully processed event timestamp. */
  lastSuccessAt: string | null;
  /** Failures in the trailing 24h where the source tracks them; null = not tracked. */
  failures24h: number | null;
  /** Honest note (e.g. "payloads not stored — no replay path"). */
  note: string | null;
};

export type LastOperation = {
  label: string;
  /** Source table the timestamp came from (transparency for operators). */
  table: string;
  at: string | null;
};

/** Kiosk-gateway adapter/certification state (kiosk_gateway provider only). */
export type GatewayAdapterInfo = {
  /** KIOSK_ADAPTER selection — 'none' when unset. */
  adapter: string;
  /**
   * True ONLY when a registered gateway adapter reports at least one real
   * capability. The registry (src/lib/kiosk/gateway-adapter.ts) is intentionally
   * empty until a vendor adapter passes docs/GATEWAY-ADAPTER.md — so today this
   * is always false and the surface is honestly 'awaiting hardware/certification'.
   */
  certified: boolean;
  /** Capability names reporting true (empty = blocked/uncertified adapter). */
  capabilities: string[];
  /** Repo-relative certification checklist path. */
  checklist: string;
};

export type IntegrationDetail = {
  provider: IntegrationRow;
  readAuth: {
    status: ReadAuthStatus;
    /** One-line evidence summary (scrubbed check detail or verification state). */
    evidence: string | null;
    checkedAt: string | null;
    latencyMs: number | null;
  };
  writeAuth: {
    status: WriteAuthStatus;
    note: string;
    /** Deploy providers only: live write-capability from the last real verification, if any. */
    writeCapability: "proven" | "unverified" | "none" | null;
  };
  webhook: WebhookDetail;
  lastOperation: LastOperation | null;
  /** Required env vars currently absent — exact names. */
  missingSettings: string[];
  /** Optional env vars currently absent. */
  optionalMissing: string[];
  /** Curated least-privilege guidance. */
  requiredPermissions: string;
  /** Imperative owner checklist. */
  requiredAction: string[];
  /** What the integration can actually do today (curated, honest). */
  capabilities: string[];
  /** Kiosk gateway only: adapter selection + certification state. */
  adapter: GatewayAdapterInfo | null;
  docs: readonly { label: string; url: string }[];
  /** Credential metadata (names/purposes/rotation only — never values). */
  secrets: SecretMeta[];
};

/* ── Static per-provider operational metadata ──────────────────────────── */

type ProviderOpsMeta = {
  /** Env vars that MUST be set for the provider to function. */
  requiredEnv: readonly string[];
  /** Env vars that are optional tuning/fallbacks. */
  optionalEnv?: readonly string[];
  requiredPermissions: string;
  requiredAction: string[];
  docs: readonly { label: string; url: string }[];
  /** Outbound write posture — 'none' only when the integration is genuinely read-only/inbound-only. */
  writeAuth: WriteAuthStatus;
  writeNote: string;
  /** Curated capability list shown to operators. */
  capabilities: readonly string[];
  /** Dynamic docs (e.g. repo-relative checklist linked via GitHub when configured). */
  docsFn?: () => readonly { label: string; url: string }[];
};

const META: Record<string, ProviderOpsMeta> = {
  stripe: {
    requiredEnv: ["STRIPE_SECRET_KEY"],
    optionalEnv: ["STRIPE_WEBHOOK_SECRET", "STRIPE_TAX_ENABLED"],
    requiredPermissions:
      "Secret key: restricted key preferred — Checkout Sessions write, PaymentIntents write (manual capture), Refunds write, Disputes read, Customers read, Webhook Endpoints read. Webhook endpoint must subscribe to checkout.session.*, payment_intent.*, charge.refunded, charge.dispute.* events; STRIPE_WEBHOOK_SECRET must match that endpoint's signing secret.",
    requiredAction: [
      "Set STRIPE_SECRET_KEY (sk_live_… or restricted rk_live_…) in the Vercel project env.",
      "In Stripe Dashboard → Developers → Webhooks, confirm the endpoint points at /api/webhooks/stripe and copy its signing secret into STRIPE_WEBHOOK_SECRET.",
      "Run the health check on this page — it performs a read-only GET /v1/balance. Write capability stays 'unverified' until a real checkout/refund succeeds.",
      "Optionally set STRIPE_TAX_ENABLED=1 only after Stripe Tax is activated on the account.",
    ],
    docs: [
      { label: "Stripe API keys & restricted keys", url: "https://docs.stripe.com/keys" },
      { label: "Stripe webhook signing & verification", url: "https://docs.stripe.com/webhooks" },
    ],
    writeAuth: "unverified",
    writeNote: "Writes (checkout sessions, captures, refunds) only happen inside payment flows — no safe probe exists, so write stays 'unverified' until a real transaction succeeds.",
    capabilities: [
      "checkout sessions + manual-capture payment holds",
      "refunds, disputes, payout/balance reads",
      "Stripe Tax (when STRIPE_TAX_ENABLED=1 and Tax is active on the account)",
      "signed billing webhooks → /api/webhooks/stripe",
    ],
  },
  supabase: {
    requiredEnv: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    requiredPermissions:
      "Project URL + anon key (browser-safe) + service-role key (full DB access — server only, never NEXT_PUBLIC_). Service role bypasses RLS; keep it out of client bundles.",
    requiredAction: [
      "Confirm all three env vars are set in Vercel (Project Settings → API in the Supabase dashboard provides the values).",
      "Run the health check — it performs a bounded SELECT against system_feature_flags.",
      "If the check fails with a connection error, verify the project is not paused and the service-role key matches the project URL.",
    ],
    docs: [
      { label: "Supabase API keys", url: "https://supabase.com/docs/guides/getting-started/api-keys" },
      { label: "Supabase service role key & RLS", url: "https://supabase.com/docs/guides/database/postgres/row-level-security" },
    ],
    writeAuth: "unverified",
    writeNote: "The service-role key grants full DB write and is exercised continuously by server routes — there is no single probe that proves write, so it stays 'unverified' by design.",
    capabilities: [
      "Postgres reads/writes for every server route (service role)",
      "auth, storage, realtime channels",
      "migration/backup/recovery surfaces under /system",
    ],
  },
  brevo: {
    requiredEnv: ["BREVO_API_KEY"],
    optionalEnv: ["SUPPORT_FROM_EMAIL"],
    requiredPermissions:
      "Brevo API key (SMTP & API → API Keys) with transactional email send rights on a validated sender/domain. Inbound email additionally needs EMAIL_INBOUND_SECRET configured as a shared secret on the Brevo inbound webhook.",
    requiredAction: [
      "Create an API key in Brevo → SMTP & API → API Keys and set BREVO_API_KEY.",
      "Set SUPPORT_FROM_EMAIL to a verified sender on your Brevo account.",
      "For inbound support email: configure the Brevo inbound webhook to POST /api/webhooks/email/inbound with EMAIL_INBOUND_SECRET as the shared secret (comma-separated allowed for rotation).",
      "Run the health check — read-only GET /v3/account verifies the key.",
    ],
    docs: [
      { label: "Brevo transactional email API", url: "https://developers.brevo.com/docs/send-a-transactional-email" },
      { label: "Brevo API keys", url: "https://help.brevo.com/hc/en-us/articles/209467485-Where-can-I-find-my-SMTP-key-" },
    ],
    writeAuth: "unverified",
    writeNote: "Outbound send is only exercised by real mail (helpdesk replies, receipts). Check email_outbox 'sent' rows for evidence of a successful send.",
    capabilities: [
      "primary transactional email (helpdesk replies, receipts, notifications)",
      "inbound support mail → tickets (with EMAIL_INBOUND_SECRET configured)",
    ],
  },
  resend: {
    requiredEnv: ["RESEND_API_KEY"],
    optionalEnv: ["SUPPORT_FROM_EMAIL"],
    requiredPermissions:
      "Resend API key (Sending access) on a verified domain. Delivery-event webhooks need RESEND_WEBHOOK_SECRET matching the endpoint's signing secret. Fallback mailer — only used when BREVO_API_KEY is unset.",
    requiredAction: [
      "Create a sending key in Resend → API Keys and set RESEND_API_KEY (only needed if Brevo is not configured).",
      "Verify your sending domain in Resend and set SUPPORT_FROM_EMAIL accordingly.",
      "For delivery/bounce tracking: add the Resend webhook endpoint /api/webhooks/email/delivery and set RESEND_WEBHOOK_SECRET to its signing secret.",
      "Run the health check — read-only GET /domains verifies the key.",
    ],
    docs: [
      { label: "Resend API keys & sending", url: "https://resend.com/docs/api-reference/api-keys" },
      { label: "Resend webhooks & signing secret", url: "https://resend.com/docs/dashboard/webhooks/introduction" },
    ],
    writeAuth: "unverified",
    writeNote: "Send-only fallback mailer; write capability is proven implicitly by email_outbox 'sent' rows, not by a dedicated probe.",
    capabilities: [
      "fallback transactional email when BREVO_API_KEY is unset",
      "delivery/bounce webhooks → email_delivery_events (with RESEND_WEBHOOK_SECRET)",
    ],
  },
  twilio: {
    requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    requiredPermissions:
      "Account SID + auth token (Twilio Console → Account) and an owned SMS-capable sender number. The auth token also signs inbound webhook callbacks (X-Twilio-Signature HMAC-SHA1).",
    requiredAction: [
      "Copy Account SID + Auth Token from the Twilio Console and set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.",
      "Set TWILIO_FROM_NUMBER to an SMS-capable number on the account.",
      "In Twilio → Phone Numbers → your number → Messaging, set the inbound webhook to https://<domain>/api/webhooks/twilio (POST).",
      "Run the health check — read-only GET on the account resource verifies credentials.",
    ],
    docs: [
      { label: "Twilio API credentials", url: "https://www.twilio.com/docs/iam/api-keys" },
      { label: "Twilio request validation (webhook signatures)", url: "https://www.twilio.com/docs/usage/webhooks/webhooks-security" },
    ],
    writeAuth: "unverified",
    writeNote: "SMS sends happen inside rental/notification flows; sms_messages rows with status 'sent'/'delivered' are the evidence of a working write path.",
    capabilities: [
      "outbound rental/notification SMS",
      "inbound SMS + delivery callbacks (STOP/START opt-outs handled inline)",
    ],
  },
  openrouter: {
    requiredEnv: ["OPENROUTER_API_KEY"],
    optionalEnv: ["OPENROUTER_MODEL"],
    requiredPermissions:
      "OpenRouter API key (Dashboard → Keys) — optionally with a credit limit. OPENROUTER_MODEL selects the default chat model; unset uses the library default.",
    requiredAction: [
      "Create a key at https://openrouter.ai/keys and set OPENROUTER_API_KEY.",
      "Optionally set OPENROUTER_MODEL to a specific model slug.",
      "Run the health check — read-only GET /api/v1/auth/key verifies the key and returns its credit/limit metadata.",
    ],
    docs: [
      { label: "OpenRouter API keys", url: "https://openrouter.ai/docs/quickstart" },
      { label: "OpenRouter authentication", url: "https://openrouter.ai/docs/api/reference/authentication" },
    ],
    writeAuth: "unverified",
    writeNote: "Chat completions are metered writes; ai_agent_runs rows with status 'ok' are the evidence a real completion succeeded.",
    capabilities: [
      "assistant / receptionist / triage chat completions",
      "agent runs, approvals and knowledge surfaces under /system/ai",
    ],
  },
  github: {
    requiredEnv: ["GITHUB_TOKEN", "GITHUB_REPO"],
    optionalEnv: ["GITHUB_DEPLOY_REFS"],
    requiredPermissions:
      "Fine-grained PAT or GitHub App on the repo only: Contents=read, Pull requests=read, Checks=read (Metadata=read automatic). This integration performs ZERO GitHub writes — deploys go through Vercel's git integration.",
    requiredAction: [
      "Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new scoped to the repo with read-only permissions, set GITHUB_TOKEN.",
      "Set GITHUB_REPO=owner/name.",
      "Optionally widen deployable refs via GITHUB_DEPLOY_REFS (default: main only).",
      "Run the health check — read-only repo fetch verifies the token and returns granted scopes.",
    ],
    docs: [
      { label: "GitHub fine-grained personal access tokens", url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" },
      { label: "GitHub REST API — authentication", url: "https://docs.github.com/en/rest/overview/authenticating-to-the-rest-api" },
    ],
    writeAuth: "none",
    writeNote: "Read-only client — deployments/PRs/checks are fetched, never written. Deploy triggers go through Vercel, not the GitHub API.",
    capabilities: [
      "repo metadata, commits, deployments, PRs and check-run reads for the deploy center",
    ],
  },
  vercel: {
    requiredEnv: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
    optionalEnv: ["VERCEL_TEAM_ID"],
    requiredPermissions:
      "Vercel access token scoped to the owning team/account (no per-endpoint scopes — narrowest scope covering the project). Read on deployments is required; write on deployments is needed ONLY for API-triggered deploys/instant rollback.",
    requiredAction: [
      "Create a token at https://vercel.com/account/settings/tokens scoped to the team that owns the project; set VERCEL_TOKEN.",
      "Set VERCEL_PROJECT_ID (project → Settings → General → Project ID); optionally VERCEL_TEAM_ID.",
      "Run the health check — read-only GET /v6/deployments verifies the token.",
      "Write capability stays 'unverified' until the first approved deployment request actually creates/promotes a deployment.",
    ],
    docs: [
      { label: "Vercel REST API", url: "https://vercel.com/docs/rest-api" },
      { label: "Vercel access tokens", url: "https://vercel.com/docs/accounts/access-tokens" },
    ],
    writeAuth: "unverified",
    writeNote: "Deployment create/promote/cancel calls exist but are only exercised by approved deployment requests — verification is read-only.",
    capabilities: [
      "deployment list/events reads for the deploy center",
      "deployment create/promote/cancel on approved requests (write unverified until first real deploy)",
    ],
  },
  kiosk_gateway: {
    requiredEnv: ["KIOSK_INGEST_SECRET"],
    optionalEnv: ["KIOSK_ADAPTER", "DEVICE_CREDENTIAL_KEK", "DEVICE_CREDENTIAL_KEK_VERSION", "DEVICE_CREDENTIAL_KEK_PREVIOUS"],
    requiredPermissions:
      "Shared bearer secret (KIOSK_INGEST_SECRET) presented by kiosks/gateways on /api/devices/events and kiosk manifest/playback. Per-device HMAC credentials (DEVICE_CREDENTIAL_KEK chain) layer on top for device auth. Outbound control additionally requires a CERTIFIED vendor adapter selected via KIOSK_ADAPTER — none is registered today.",
    requiredAction: [
      "Generate a random secret and set KIOSK_INGEST_SECRET in Vercel.",
      "Provision the same secret to every kiosk/gateway — devices presenting the old secret are rejected until updated.",
      "Confirm device_events / system_device_messages rows appear after devices reconnect (health check counts last-24h events).",
      "For outbound control (commands/firmware): select KIOSK_ADAPTER only after the vendor adapter passes the certification checklist in docs/GATEWAY-ADAPTER.md — the adapter registry is intentionally empty until then.",
      "KEK rotation: follow the runbook in SECRET_REGISTRY (DEVICE_CREDENTIAL_KEK → PREVIOUS/VERSION overlap → re-encrypt → unset PREVIOUS).",
    ],
    // No public vendor docs exist; link the repo checklist via GitHub when the
    // repo is configured, otherwise the path is still named in requiredAction.
    docs: [],
    docsFn: () => {
      const r = parseGithubRepo();
      return r
        ? [{ label: "Gateway adapter certification checklist (docs/GATEWAY-ADAPTER.md)", url: `https://github.com/${r.owner}/${r.repo}/blob/HEAD/docs/GATEWAY-ADAPTER.md` }]
        : [];
    },
    writeAuth: "none",
    writeNote: "Inbound ingest is device→server. Outbound device control exists in code but is BLOCKED until a certified KIOSK_ADAPTER lands — see the adapter block below.",
    capabilities: [
      "device event ingest + kiosk manifest/playback (Bearer KIOSK_INGEST_SECRET)",
      "per-device HMAC credential auth (DEVICE_CREDENTIAL_KEK chain)",
      "outbound commands/firmware — blocked: no certified vendor adapter registered",
    ],
  },
  analytics: {
    requiredEnv: [],
    requiredPermissions:
      "None server-side — NEXT_PUBLIC_* values are public by design and ship in the client bundle. Mapbox tokens should carry URL restrictions in the Mapbox dashboard; GA4/GTM need no secret at all.",
    requiredAction: [
      "Set whichever of NEXT_PUBLIC_GTM_ID / NEXT_PUBLIC_GA_MEASUREMENT_ID / NEXT_PUBLIC_MAPBOX_TOKEN apply — each surface is independent; leaving all unset disables it honestly.",
      "Verify in the browser: GTM Preview for the container, GA4 Realtime for the measurement ID, a real map render for Mapbox (locator/network pages).",
      "There is no server-side probe — env presence is the only server-visible signal; 'unverified' here is expected, not a failure.",
    ],
    docs: [
      { label: "Google Tag Manager", url: "https://developers.google.com/tag-platform/tag-manager" },
      { label: "GA4 measurement ID", url: "https://support.google.com/analytics/answer/12270356" },
      { label: "Mapbox access tokens & URL restrictions", url: "https://docs.mapbox.com/help/glossary/access-token/" },
    ],
    writeAuth: "none",
    writeNote: "Public client-side configuration — the server only reports presence; all real usage happens in the browser.",
    capabilities: [
      "consent-gated page-view/event tracking via GTM/GA4",
      "Mapbox locator + network map rendering",
    ],
  },
  alerts: {
    requiredEnv: ["ALERT_WEBHOOK_URL"],
    requiredPermissions:
      "Outbound webhook endpoint accepting a JSON POST ({ text, zapnivo: { severity, key, title, body, ts } }) — Slack incoming webhook or PagerDuty Events API style. No inbound auth exists; treat the URL itself as a secret (it embeds the provider credential).",
    requiredAction: [
      "Create an alert destination (Slack workflow webhook / PagerDuty integration) and set ALERT_WEBHOOK_URL (https).",
      "Alerts fire only on NEW warning/critical error_issues fingerprints plus selected sweep detections — there is no test button; trigger a real warning or wait for the next alert sweep.",
      "Run the health check — it reads the latest external_alert_* row in app_logs (delivery evidence, never a live POST from this page).",
      "Optional: ALERT_COOLDOWN_MS tunes per-key storm suppression (default 15 min).",
    ],
    docs: [
      { label: "Slack incoming webhooks", url: "https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks" },
      { label: "PagerDuty Events API v2", url: "https://developer.pagerduty.com/docs/events-api-v2/overview/" },
    ],
    writeAuth: "none",
    writeNote: "Outbound-only — the app POSTs alerts to the configured URL; nothing calls back in.",
    capabilities: [
      "push alerts for new warning/critical issues — survives mail/API outages",
      "per-key cooldown storm suppression",
    ],
  },
  uptime: {
    requiredEnv: ["CRON_SECRET"],
    requiredPermissions:
      "CRON_SECRET bearer authorizes /api/cron/* including /api/cron/uptime (synthetic probes → uptime_checks). Supabase service role must be present for the checks to persist.",
    requiredAction: [
      "Ensure CRON_SECRET is set and the external scheduler (Vercel cron / cron-job.org) calls /api/cron/uptime with Authorization: Bearer <CRON_SECRET>.",
      "Confirm uptime_checks rows are being written (health check counts last-24h probes).",
      "If probes are missing, check Vercel → Project → Cron Jobs and the cron route logs.",
    ],
    docs: [
      { label: "Vercel cron jobs", url: "https://vercel.com/docs/cron-jobs" },
    ],
    writeAuth: "none",
    writeNote: "Internal observability — no external provider credentials involved.",
    capabilities: [
      "synthetic uptime probes → uptime_checks via /api/cron/uptime",
      "cron run telemetry feeding the status board and alert sweep",
    ],
  },
};

/* ── Webhook / last-operation source mapping ───────────────────────────── */

type WebhookSpec = {
  endpoint: string;
  secretEnv: string | null;
  description: string;
  note: string | null;
  /** Bounded queries producing the webhook timing fields. */
  probe: (db: SupabaseClient) => Promise<Pick<WebhookDetail, "lastEventAt" | "lastSuccessAt" | "failures24h">>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

async function lastTs(db: SupabaseClient, table: string, column: string, apply?: (q: Q) => Q): Promise<string | null> {
  try {
    let q = db.from(table).select(column).order(column, { ascending: false }).limit(1);
    if (apply) q = apply(q);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return (data as unknown as Record<string, unknown>)[column] as string | null;
  } catch {
    return null;
  }
}

async function countWhere(db: SupabaseClient, table: string, sinceIso: string, apply?: (q: Q) => Q): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true }).gte("created_at", sinceIso);
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

async function countGte(db: SupabaseClient, table: string, column: string, sinceIso: string, apply?: (q: Q) => Q): Promise<number | null> {
  try {
    let q = db.from(table).select("id", { count: "exact", head: true }).gte(column, sinceIso);
    if (apply) q = apply(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  } catch {
    return null;
  }
}

const dayAgo = () => new Date(Date.now() - 24 * 3600_000).toISOString();

const WEBHOOK_SPECS: Partial<Record<string, WebhookSpec>> = {
  stripe: {
    endpoint: "/api/webhooks/stripe",
    secretEnv: "STRIPE_WEBHOOK_SECRET",
    description: "Payment events dedupe ledger — only id/type/received_at stored.",
    note: "Payloads are not stored — no replay path; re-send from the Stripe dashboard if needed.",
    probe: async (db) => ({
      lastEventAt: await lastTs(db, "stripe_events", "received_at"),
      lastSuccessAt: await lastTs(db, "stripe_events", "received_at"),
      failures24h: null,
    }),
  },
  brevo: {
    endpoint: "/api/webhooks/email/inbound",
    secretEnv: "EMAIL_INBOUND_SECRET",
    description: "Inbound support mail → durable inbound_jobs queue (worker at /api/cron/inbound).",
    note: "inbound_emails rows marked 'quarantined' are auth/validation failures — review in the helpdesk flow.",
    probe: async (db) => {
      const since = dayAgo();
      const [lastEventAt, lastJobDone, lastMailOk, dead24] = await Promise.all([
        lastTs(db, "inbound_jobs", "created_at"),
        lastTs(db, "inbound_jobs", "processed_at", (q) => q.eq("status", "done")),
        lastTs(db, "inbound_emails", "created_at", (q) => q.eq("status", "accepted")),
        countWhere(db, "inbound_jobs", since, (q) => q.eq("status", "dead")),
      ]);
      const successCandidates = [lastJobDone, lastMailOk].filter((x): x is string => Boolean(x));
      return {
        lastEventAt,
        lastSuccessAt: successCandidates.sort().pop() ?? null,
        failures24h: dead24,
      };
    },
  },
  resend: {
    endpoint: "/api/webhooks/email/delivery",
    secretEnv: "RESEND_WEBHOOK_SECRET",
    description: "Delivery events (accepted/delivered/bounce/complaint) → email_delivery_events.",
    note: "Only configured if RESEND_WEBHOOK_SECRET is set on both Resend and this app.",
    probe: async (db) => ({
      lastEventAt: await lastTs(db, "email_delivery_events", "received_at", (q) => q.eq("provider", "resend")),
      lastSuccessAt: await lastTs(db, "email_delivery_events", "received_at", (q) => q.eq("provider", "resend").in("event_type", ["accepted", "delivered"])),
      failures24h: await countGte(db, "email_delivery_events", "received_at", dayAgo(), (q) => q.eq("provider", "resend").in("event_type", ["hard_bounce", "complaint", "failed"])),
    }),
  },
  twilio: {
    endpoint: "/api/webhooks/twilio",
    // No dedicated secret — requests are authenticated by X-Twilio-Signature
    // HMAC using TWILIO_AUTH_TOKEN.
    secretEnv: null,
    description: "Inbound SMS + delivery-status callbacks; STOP/START opt-outs handled inline.",
    note: "Authenticated via Twilio request signature (TWILIO_AUTH_TOKEN) — no separate webhook secret.",
    probe: async (db) => {
      const since = dayAgo();
      return {
        lastEventAt: await lastTs(db, "sms_messages", "created_at"),
        lastSuccessAt: await lastTs(db, "sms_messages", "created_at", (q) => q.in("status", ["sent", "delivered", "received"])),
        failures24h: await countWhere(db, "sms_messages", since, (q) => q.in("status", ["failed", "undelivered"])),
      };
    },
  },
  kiosk_gateway: {
    endpoint: "/api/devices/events",
    secretEnv: "KIOSK_INGEST_SECRET",
    description: "Device ingest + kiosk manifest/playback; append-only system_device_messages telemetry.",
    note: "result='rejected' rows are failed auth attempts — investigate device credential state.",
    probe: async (db) => {
      const since = dayAgo();
      return {
        lastEventAt: await lastTs(db, "system_device_messages", "received_at"),
        lastSuccessAt: await lastTs(db, "system_device_messages", "received_at", (q) => q.eq("result", "ok")),
        failures24h: await countGte(db, "system_device_messages", "received_at", since, (q) => q.eq("result", "rejected")),
      };
    },
  },
};

type OpSpec = { label: string; table: string; column: string; apply?: (q: Q) => Q };

const OP_SPECS: Partial<Record<string, OpSpec>> = {
  stripe: { label: "last Stripe webhook event recorded", table: "stripe_events", column: "received_at" },
  brevo: { label: "last outbound email sent (Brevo/Resend outbox)", table: "email_outbox", column: "created_at", apply: (q) => q.eq("status", "sent") },
  resend: { label: "last Resend delivery event received", table: "email_delivery_events", column: "received_at", apply: (q) => q.eq("provider", "resend") },
  twilio: { label: "last SMS delivered/sent", table: "sms_messages", column: "created_at", apply: (q) => q.in("status", ["sent", "delivered"]) },
  openrouter: { label: "last successful AI agent run", table: "ai_agent_runs", column: "created_at", apply: (q) => q.eq("status", "ok") },
  kiosk_gateway: { label: "last accepted device message", table: "system_device_messages", column: "received_at", apply: (q) => q.eq("result", "ok") },
  uptime: { label: "last uptime probe", table: "uptime_checks", column: "checked_at" },
  alerts: { label: "last external alert delivery attempt", table: "app_logs", column: "ts", apply: (q) => q.in("message", ["external_alert_delivered", "external_alert_failed"]) },
};

/* ── Detail assembly ───────────────────────────────────────────────────── */

function readAuthFromCheck(check: LastHealthCheck | null): IntegrationDetail["readAuth"] {
  if (!check) {
    return { status: "not_run", evidence: "no health check recorded yet — run one from this page", checkedAt: null, latencyMs: null };
  }
  switch (check.status) {
    case "operational":
      return { status: "verified", evidence: check.detail, checkedAt: check.checkedAt, latencyMs: check.latencyMs };
    case "degraded":
      return { status: "failed", evidence: check.detail, checkedAt: check.checkedAt, latencyMs: check.latencyMs };
    case "unconfigured":
      return { status: "unverified", evidence: check.detail, checkedAt: check.checkedAt, latencyMs: check.latencyMs };
    default: // unknown / requires_credentials / not_verified
      return { status: "unverified", evidence: check.detail, checkedAt: check.checkedAt, latencyMs: check.latencyMs };
  }
}

const DEPLOY_IDS = new Set(["github", "vercel"]);

/**
 * Full operational detail for ONE provider. Bounded: at most a handful of
 * limit-1/head-count queries against whitelisted non-PII columns, plus one
 * audit lookup for the latest health check. Returns null for unknown ids.
 */
export async function getIntegrationDetail(
  db: SupabaseClient | null,
  id: string,
): Promise<IntegrationDetail | null> {
  const provider = getProvider(id);
  if (!provider) return null;
  const meta = META[id];
  if (!meta) return null;

  // Registry row + the LATEST audited health check for THIS provider only
  // (targeted limit-1 read — same parse as listIntegrationStatus).
  const base = listIntegrations().find((r) => r.id === id) ?? null;
  if (!base) return null;
  let lastHealthCheck: LastHealthCheck | null = null;
  if (db) {
    try {
      const { data } = await db
        .from("system_audit_events")
        .select("detail,created_at")
        .eq("action", "integration.health_checked")
        .eq("resource", `integration:${id}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        const r = data as unknown as { detail: Record<string, unknown> | null; created_at: string };
        const d = r.detail ?? {};
        lastHealthCheck = {
          status: (typeof d.status === "string" ? d.status : "unknown") as LastHealthCheck["status"],
          checkedAt: r.created_at,
          latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null,
          detail: typeof d.detail === "string" ? d.detail.slice(0, 200) : null,
        };
      }
    } catch { /* audit read is best-effort */ }
  }
  const row: IntegrationRow = { ...base, lastHealthCheck };

  const webhookSpec = WEBHOOK_SPECS[id];
  const opSpec = OP_SPECS[id];

  const [webhookProbe, lastOpAt] = await Promise.all([
    db && webhookSpec ? webhookSpec.probe(db) : Promise.resolve(null),
    db && opSpec ? lastTs(db, opSpec.table, opSpec.column, opSpec.apply) : Promise.resolve(null),
  ]);

  const webhook: WebhookDetail = webhookSpec
    ? {
        applicable: true,
        endpoint: webhookSpec.endpoint,
        secretEnv: webhookSpec.secretEnv,
        secretSet: webhookSpec.secretEnv ? Boolean(process.env[webhookSpec.secretEnv]) : null,
        description: webhookSpec.description,
        lastEventAt: webhookProbe?.lastEventAt ?? null,
        lastSuccessAt: webhookProbe?.lastSuccessAt ?? null,
        failures24h: webhookProbe?.failures24h ?? null,
        note: webhookSpec.note,
      }
    : {
        applicable: false,
        endpoint: null,
        secretEnv: null,
        secretSet: null,
        description: null,
        lastEventAt: null,
        lastSuccessAt: null,
        failures24h: null,
        note: "No inbound webhook surface for this provider.",
      };

  // Deploy providers: pick up the cached verification's write capability —
  // 'proven' only after a real verify run this process; otherwise the static
  // posture stays ('unverified' for vercel, 'none' for github).
  let writeStatus: WriteAuthStatus = meta.writeAuth;
  let writeCapability: IntegrationDetail["writeAuth"]["writeCapability"] = null;
  if (DEPLOY_IDS.has(id)) {
    const ver = cachedProviderVerification(id as DeployProviderId);
    if (ver) {
      writeCapability = ver.writeCapability ?? null;
      if (ver.writeCapability === "proven") writeStatus = "proven";
    }
  }

  // Presence booleans only — env VALUES are never read into the response.
  const missingSettings = meta.requiredEnv.filter((n) => !process.env[n]);
  const optionalMissing = (meta.optionalEnv ?? []).filter((n) => !process.env[n]);

  const secrets = SECRET_REGISTRY.filter(
    (s) =>
      s.provider === id ||
      (id === "uptime" && s.envVar === "CRON_SECRET") ||
      (id === "brevo" && s.envVar === "EMAIL_INBOUND_SECRET") ||
      ((id === "brevo" || id === "resend") && s.envVar === "SUPPORT_FROM_EMAIL") ||
      // Device credential KEK chain is registered under 'platform' but is the
      // kiosk gateway's rotation surface — surface it on this provider too.
      (id === "kiosk_gateway" && s.envVar.startsWith("DEVICE_CREDENTIAL_KEK")),
  );

  // Kiosk gateway only: honest adapter/certification state. 'certified' is
  // true ONLY when a registered adapter reports real capabilities — the
  // registry is intentionally empty until docs/GATEWAY-ADAPTER.md is satisfied.
  const adapter: GatewayAdapterInfo | null =
    id === "kiosk_gateway"
      ? (() => {
          const name = kioskAdapterName();
          try {
            const caps = getGatewayAdapter().capabilities();
            const on = Object.entries(caps)
              .filter(([, v]) => v === true)
              .map(([k]) => k);
            return { adapter: name, certified: on.length > 0, capabilities: on, checklist: "docs/GATEWAY-ADAPTER.md" };
          } catch {
            return { adapter: name, certified: false, capabilities: [], checklist: "docs/GATEWAY-ADAPTER.md" };
          }
        })()
      : null;

  return {
    provider: row,
    readAuth: readAuthFromCheck(row.lastHealthCheck),
    writeAuth: {
      status: writeStatus,
      note: meta.writeNote,
      writeCapability,
    },
    webhook,
    lastOperation: opSpec
      ? { label: opSpec.label, table: opSpec.table, at: lastOpAt }
      : null,
    missingSettings,
    optionalMissing,
    requiredPermissions: meta.requiredPermissions,
    requiredAction: meta.requiredAction,
    capabilities: [...meta.capabilities],
    adapter,
    docs: meta.docsFn ? meta.docsFn() : meta.docs,
    secrets,
  };
}
