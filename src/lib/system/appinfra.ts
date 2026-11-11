import { SUB_PREFIX } from "@/lib/subdomains";
import { SECRET_REGISTRY } from "./integrations";

/**
 * Application-infrastructure section of the system console.
 *
 * Deployment info comes ONLY from platform-injected env vars (VERCEL_*); no
 * Vercel API token exists in this app, so deployment history is reported as
 * unavailable rather than fabricated. The environment matrix exposes variable
 * NAMES and presence booleans only — values are never returned except for an
 * explicit allowlist of nonsecret flags.
 */

export type DeploymentInfo = {
  environment: string | null;
  commitSha: string | null;
  commitShaShort: string | null;
  vercelUrl: string | null;
  branchUrl: string | null;
  siteUrlConfigured: boolean;
  vercelTokenConfigured: boolean;
  checkedAt: string;
};

export function getDeploymentInfo(): DeploymentInfo {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return {
    environment: process.env.VERCEL_ENV ?? null,
    commitSha: sha,
    commitShaShort: sha ? sha.slice(0, 7) : null,
    vercelUrl: process.env.VERCEL_URL ?? null,
    branchUrl: process.env.VERCEL_BRANCH_URL ?? null,
    siteUrlConfigured: Boolean(process.env.NEXT_PUBLIC_SITE_URL),
    // Presence check only — the value is never read into a response.
    vercelTokenConfigured: Boolean(process.env.VERCEL_TOKEN),
    checkedAt: new Date().toISOString(),
  };
}

/* ── Route surfaces (real data from src/lib/subdomains.ts) ─────────────── */

export type RouteSurface = {
  subdomain: string;
  host: string;
  pathPrefix: string;
  surface: string;
  notes: string;
};

const SURFACE_LABELS: Record<string, { surface: string; notes: string }> = {
  support: { surface: "Customer help center", notes: "Tickets, helpdesk threads, AI assistant. Public-facing (indexable)." },
  internal: { surface: "Staff console", notes: "Admin portal (/admin). Requires staff auth." },
  partners: { surface: "Partner portal", notes: "Venue partner onboarding/ops (/partners)." },
  customer: { surface: "Customer account", notes: "Customer account portal (/account)." },
  system: { surface: "System control plane", notes: "This console (/system). Requires profiles.system_role." },
  api: { surface: "API gateway", notes: "api.<domain>/* rewrites to /api/*; JSON 200 at root, robots disallow." },
};

export function getRouteSurfaces(): RouteSurface[] {
  const rows: RouteSurface[] = [];
  for (const [sub, prefix] of Object.entries(SUB_PREFIX) as [string, string][]) {
    const meta = SURFACE_LABELS[sub] ?? { surface: sub, notes: "" };
    rows.push({
      subdomain: `${sub}.zapnivo.com`,
      host: `${sub}.zapnivo.com`,
      pathPrefix: prefix,
      surface: meta.surface,
      notes: meta.notes,
    });
  }
  rows.push({
    subdomain: "api.zapnivo.com",
    host: "api.zapnivo.com",
    pathPrefix: "/api",
    surface: SURFACE_LABELS.api.surface,
    notes: SURFACE_LABELS.api.notes,
  });
  rows.push({
    subdomain: "zapnivo.com (apex)",
    host: "zapnivo.com",
    pathPrefix: "/",
    surface: "Marketing site",
    notes: "Portal paths 308-redirect to their subdomain; *.zapnivo.com typos canonicalize to apex.",
  });
  return rows;
}

/* ── Environment matrix ────────────────────────────────────────────────── */

export type EnvCategory = "secret" | "config" | "public" | "platform";

export type EnvRow = {
  name: string;
  category: EnvCategory;
  configured: boolean;
  /** Nonsecret value, ONLY for the explicit SAFE_VALUE_VARS allowlist. */
  value?: string;
  valueNote?: string;
  scope: string;
  purpose: string;
};

/**
 * The ONLY env vars whose values may appear in API/page output. Everything
 * else is presence-only. Keep this list tiny and obviously nonsecret.
 */
export const SAFE_VALUE_VARS: ReadonlySet<string> = new Set([
  "KIOSK_ADAPTER",
  "GIFT_SALES_ENABLED",
  "STRIPE_TAX_ENABLED",
  "HELPDESK_DEV_STORE",
  "SYSTEM_DEV_ROLE",
]);

type EnvSpec = { name: string; category: EnvCategory; purpose: string; scope: string };

const CONFIG_VARS: readonly EnvSpec[] = [
  { name: "KIOSK_ADAPTER", category: "config", purpose: "Selects the kiosk hardware adapter implementation", scope: "server" },
  { name: "GIFT_SALES_ENABLED", category: "config", purpose: "Feature flag: gift sales checkout", scope: "server" },
  { name: "STRIPE_TAX_ENABLED", category: "config", purpose: "Feature flag: Stripe automatic tax", scope: "server" },
  { name: "HELPDESK_DEV_STORE", category: "config", purpose: "Dev-only JSON helpdesk store + demo data (never in prod)", scope: "dev only" },
  { name: "SYSTEM_DEV_ROLE", category: "config", purpose: "Dev-only forced system role for the console (never in prod)", scope: "dev only" },
  { name: "RECEPTIONIST_AUTONOMY", category: "config", purpose: "AI receptionist autonomy level", scope: "server" },
  { name: "GENERAL_INBOX", category: "config", purpose: "General inbound email routing address", scope: "server" },
  { name: "BASE_DOMAIN", category: "config", purpose: "Base domain for subdomain routing (default zapnivo.com)", scope: "server/edge" },
  { name: "ALERT_COOLDOWN_MS", category: "config", purpose: "Alert dedupe cooldown window", scope: "server" },
];

const PUBLIC_VARS: readonly EnvSpec[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", category: "public", purpose: "Supabase project URL (browser-safe)", scope: "client+server" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", category: "public", purpose: "Supabase anon key (browser-safe by design)", scope: "client+server" },
  { name: "NEXT_PUBLIC_SITE_URL", category: "public", purpose: "Canonical site URL", scope: "client+server" },
  { name: "NEXT_PUBLIC_MAPBOX_TOKEN", category: "public", purpose: "Mapbox token for locator map", scope: "client" },
  { name: "NEXT_PUBLIC_GA_MEASUREMENT_ID", category: "public", purpose: "Google Analytics measurement ID", scope: "client" },
];

const PLATFORM_VARS: readonly EnvSpec[] = [
  { name: "VERCEL_ENV", category: "platform", purpose: "Vercel environment (production/preview/development)", scope: "platform-injected" },
  { name: "VERCEL_URL", category: "platform", purpose: "Deployment URL for this build", scope: "platform-injected" },
  { name: "VERCEL_BRANCH_URL", category: "platform", purpose: "Branch preview URL", scope: "platform-injected" },
  { name: "VERCEL_GIT_COMMIT_SHA", category: "platform", purpose: "Git commit SHA of this deployment", scope: "platform-injected" },
  { name: "NODE_ENV", category: "platform", purpose: "Node environment", scope: "platform-injected" },
];

/**
 * Builds the environment matrix. `configured` is a process.env PRESENCE check
 * only. Values are emitted solely for SAFE_VALUE_VARS.
 */
export function getEnvironmentMatrix(): EnvRow[] {
  const rows: EnvRow[] = [];

  // Secrets: names + purposes come from the integrations SECRET_REGISTRY so the
  // two surfaces can never drift apart. NEXT_PUBLIC_* entries are browser-safe
  // by design — they are categorized 'public' in the second pass instead.
  const publicNames = new Set(PUBLIC_VARS.map((v) => v.name));
  const seen = new Set<string>();
  for (const s of SECRET_REGISTRY) {
    if (seen.has(s.envVar) || publicNames.has(s.envVar)) continue;
    seen.add(s.envVar);
    // Registry mixes true secrets with documented nonsecret flags; category
    // follows the SAFE_VALUE_VARS allowlist so STRIPE_TAX_ENABLED et al. show
    // their (nonsecret) value instead of a bare boolean.
    const isSafe = SAFE_VALUE_VARS.has(s.envVar);
    rows.push({
      name: s.envVar,
      category: isSafe ? "config" : "secret",
      configured: Boolean(process.env[s.envVar]),
      ...(isSafe && process.env[s.envVar] !== undefined
        ? { value: process.env[s.envVar]!, valueNote: "nonsecret flag — value shown" }
        : {}),
      scope: "server (Vercel env)",
      purpose: s.purpose,
    });
  }

  for (const spec of [...CONFIG_VARS, ...PUBLIC_VARS, ...PLATFORM_VARS]) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    const safe = SAFE_VALUE_VARS.has(spec.name);
    rows.push({
      name: spec.name,
      category: spec.category,
      configured: Boolean(process.env[spec.name]),
      ...(safe && process.env[spec.name] !== undefined
        ? { value: process.env[spec.name]!, valueNote: "nonsecret flag — value shown" }
        : {}),
      scope: spec.scope,
      purpose: spec.purpose,
    });
  }

  return rows;
}
