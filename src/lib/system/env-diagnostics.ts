/**
 * Environment diagnostics for /system/dev/env — the "why is X not working"
 * page. Reports ONLY presence (set/missing) of env vars, grouped by the
 * feature area they gate. VALUES ARE NEVER READ INTO THE RESULT — the
 * `set` boolean is computed via Boolean(env[name]) and nothing else escapes.
 *
 * The `features` strings are a curated, hand-maintained map of which product
 * capabilities depend on each var. Keep it honest: if a var gates nothing
 * runtime-visible, say so.
 */

export type EnvVarStatus = {
  name: string;
  set: boolean;
  /** True for credentials/secrets (values especially sensitive — never shown). */
  secret: boolean;
  /** Product capabilities that depend on this var being set. */
  features: string[];
};

export type EnvGroup = {
  id: string;
  label: string;
  description: string;
  vars: EnvVarStatus[];
  setCount: number;
};

export type EnvDiagnostics = {
  nodeEnv: string;
  vercelEnv: string | null;
  groups: EnvGroup[];
  /** Count of required (non-optional) vars that are missing across all groups. */
  missingRequired: number;
};

type VarSpec = {
  name: string;
  secret?: boolean;
  optional?: boolean;
  features: string[];
};

type GroupSpec = {
  id: string;
  label: string;
  description: string;
  vars: readonly VarSpec[];
};

const GROUPS: readonly GroupSpec[] = [
  {
    id: "supabase",
    label: "Supabase (database / auth / realtime)",
    description: "Everything server-side reads/writes through the service-role client. If any of these is missing the whole console and most routes degrade to honest 503s.",
    vars: [
      { name: "NEXT_PUBLIC_SUPABASE_URL", features: ["all DB-backed pages", "auth", "realtime"] },
      { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", secret: true, features: ["browser client", "auth flows"] },
      { name: "SUPABASE_SERVICE_ROLE_KEY", secret: true, features: ["all /api/system/* routes", "service writes", "search/approvals/activity feeds"] },
    ],
  },
  {
    id: "payments",
    label: "Stripe (payments)",
    description: "Checkout, manual-capture holds, refunds, disputes, billing webhooks.",
    vars: [
      { name: "STRIPE_SECRET_KEY", secret: true, features: ["rental checkout", "refunds", "disputes", "billing portal"] },
      { name: "STRIPE_WEBHOOK_SECRET", secret: true, features: ["/api/webhooks/stripe signature verification"] },
      { name: "STRIPE_TAX_ENABLED", optional: true, features: ["automatic tax on checkout (flag)"] },
    ],
  },
  {
    id: "email",
    label: "Transactional email (Brevo / Resend)",
    description: "Outbound mail via Brevo SMTP API with Resend fallback (src/lib/helpdesk/mailer.ts).",
    vars: [
      { name: "BREVO_API_KEY", secret: true, features: ["helpdesk replies", "receipts", "notifications (primary)"] },
      { name: "RESEND_API_KEY", secret: true, optional: true, features: ["email fallback when BREVO_API_KEY unset"] },
      { name: "SUPPORT_FROM_EMAIL", features: ["verified sender address for all outbound mail"] },
      { name: "EMAIL_INBOUND_SECRET", secret: true, features: ["/api/webhooks/email/inbound (Brevo inbound → support tickets)"] },
    ],
  },
  {
    id: "sms",
    label: "Twilio SMS",
    description: "Rental notifications + inbound SMS webhook (STOP/START opt-outs, delivery callbacks).",
    vars: [
      { name: "TWILIO_ACCOUNT_SID", secret: true, features: ["SMS send", "inbound webhook auth"] },
      { name: "TWILIO_AUTH_TOKEN", secret: true, features: ["SMS send", "webhook signature checks"] },
      { name: "TWILIO_FROM_NUMBER", features: ["SMS sender identity"] },
    ],
  },
  {
    id: "ai",
    label: "OpenRouter (AI assistants)",
    description: "Assistant / receptionist / triage chat completions (src/lib/ai/openrouter.ts).",
    vars: [
      { name: "OPENROUTER_API_KEY", secret: true, features: ["AI assistant", "receptionist", "ticket triage", "/system/ai views"] },
      { name: "OPENROUTER_MODEL", optional: true, features: ["default chat model slug"] },
    ],
  },
  {
    id: "kiosk",
    label: "Kiosk gateway",
    description: "Device ingest at /api/devices/events + kiosk manifest/playback, and the HMAC device-credential chain.",
    vars: [
      { name: "KIOSK_INGEST_SECRET", secret: true, features: ["device event ingest", "kiosk manifest/playback"] },
      { name: "KIOSK_ADAPTER", optional: true, features: ["kiosk hardware adapter selection (none/simulator)"] },
      { name: "DEVICE_CREDENTIAL_KEK", secret: true, features: ["device credential encryption (HMAC auth)", "simulator provisioning"] },
      { name: "DEVICE_CREDENTIAL_KEK_PREVIOUS", secret: true, optional: true, features: ["KEK rotation overlap window only"] },
      { name: "DEVICE_CREDENTIAL_KEK_VERSION", optional: true, features: ["active KEK version tag during rotation"] },
    ],
  },
  {
    id: "cron",
    label: "Cron / schedulers",
    description: "External scheduler calls to /api/cron/* authenticate with this bearer secret.",
    vars: [
      { name: "CRON_SECRET", secret: true, features: ["/api/cron/inbound", "/api/cron/rentals", "/api/cron/analytics", "/api/cron/uptime", "alert sweep"] },
    ],
  },
  {
    id: "alerts",
    label: "Alerting",
    description: "Outbound staff/external notifications when observability rules fire.",
    vars: [
      { name: "ALERT_WEBHOOK_URL", secret: true, optional: true, features: ["external alert webhook (Slack/PagerDuty-style) on critical issues"] },
    ],
  },
  {
    id: "platform",
    label: "Platform / auth internals",
    description: "Cross-cutting secrets and runtime flags injected by the platform or set manually.",
    vars: [
      { name: "HELPDESK_SECRET", secret: true, features: ["signed customer helpdesk thread tokens"] },
      { name: "AUTH_ANCHOR_SECRET", secret: true, features: ["auth/session anchoring"] },
      { name: "VERCEL_ENV", optional: true, features: ["environment label (production/preview/development) in audit rows"] },
      { name: "VERCEL_GIT_COMMIT_SHA", optional: true, features: ["deploy version shown on status board"] },
      { name: "VERCEL_URL", optional: true, features: ["canonical deployment URL"] },
      { name: "GITHUB_TOKEN", secret: true, optional: true, features: ["none — no runtime GitHub API calls exist; listed for completeness"] },
      { name: "HELPDESK_DEV_STORE", optional: true, features: ["dev-only JSON helpdesk store + role switcher (MUST stay unset in prod)"] },
      { name: "SYSTEM_DEV_ROLE", optional: true, features: ["dev-only pinned system role (MUST stay unset in prod)"] },
    ],
  },
];

/**
 * Builds the presence matrix. `env` defaults to process.env and is injectable
 * for tests. The result contains ONLY booleans — env values never appear.
 */
export function envDiagnostics(env: NodeJS.ProcessEnv = process.env): EnvDiagnostics {
  let missingRequired = 0;
  const groups: EnvGroup[] = GROUPS.map((g) => {
    const vars: EnvVarStatus[] = g.vars.map((v) => {
      const set = Boolean(env[v.name]);
      if (!set && !v.optional) missingRequired += 1;
      return {
        name: v.name,
        set,
        secret: v.secret === true,
        features: [...v.features],
      };
    });
    return {
      id: g.id,
      label: g.label,
      description: g.description,
      vars,
      setCount: vars.filter((v) => v.set).length,
    };
  });
  return {
    nodeEnv: env.NODE_ENV ?? "unknown",
    vercelEnv: env.VERCEL_ENV ?? null,
    groups,
    missingRequired,
  };
}
