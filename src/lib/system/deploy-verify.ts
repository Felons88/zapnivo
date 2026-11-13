import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";
import {
  githubGate,
  vercelGate,
  verifyGithubConnection,
  verifyVercelConnection,
  type ProviderConnectionResult,
} from "./deploy-provider";

/**
 * Deployment-provider connection readiness for the Deployment Center.
 *
 * Wraps the read-only probes in deploy-provider.ts with:
 *  - a ~5 minute module-memory cache (page loads and UI polls don't hammer
 *    the provider APIs),
 *  - persistence of every REAL check as a system_audit_events row with action
 *    'integration.health_checked' — the same action integrations.ts reads to
 *    populate lastHealthCheck on the integrations registry,
 *  - operator-facing `requiredAction` copy (exact env vars + where to get
 *    credentials) so an unconfigured provider is actionable, not just red.
 *
 * Secrets are never read into responses — only env var NAMES and gate state.
 */

export type DeployProviderId = "vercel" | "github";

export const DEPLOY_PROVIDERS: readonly DeployProviderId[] = ["vercel", "github"];

export type ProviderVerification = ProviderConnectionResult & {
  provider: DeployProviderId;
  /** Last time a check fully verified this provider (module memory). */
  lastSuccessAt: string | null;
  /** Sanitized error from the most recent failed check, if any. */
  lastFailure: string | null;
  /** What an operator must do when the provider isn't usable. Null when verified. */
  requiredAction: string | null;
};

const CHECK_TTL_MS = 5 * 60_000;

const cache = new Map<DeployProviderId, { at: number; result: ProviderVerification }>();
const lastSuccess = new Map<DeployProviderId, string>();
const lastFailure = new Map<DeployProviderId, string>();

/* ── Operator guidance (no secrets — names + where to obtain them) ─────── */

export const PROVIDER_REQUIRED_ACTION: Record<DeployProviderId, string> = {
  vercel:
    "Create a token at https://vercel.com/account/settings/tokens (scope: your team or 'full account'; the token needs read access to the project and write access for deployments/instant rollback). Then set VERCEL_TOKEN, VERCEL_PROJECT_ID (Vercel dashboard → project → Settings → General → Project ID) and optionally VERCEL_TEAM_ID (team Settings → General). For git-triggered deploys also set VERCEL_GIT_REPO_ID or GITHUB_TOKEN+GITHUB_REPO so the repo id resolves.",
  github:
    "Preferred: install a GitHub App on the repository with Contents:read, Pull requests:read and Metadata:read (least privilege, short-lived tokens) — App auth is NOT implemented yet, so use a fine-grained PAT at https://github.com/settings/personal-access-tokens/new scoped to this repo only (Contents:read, Pull requests:read, Metadata:read) as GITHUB_TOKEN, and set GITHUB_REPO=owner/name. Optionally widen deployable refs via GITHUB_DEPLOY_REFS (default: main only; branch/tag names or trailing-* patterns — raw commit SHAs are not accepted unless listed literally).",
};

function toVerification(provider: DeployProviderId, r: ProviderConnectionResult): ProviderVerification {
  const usable = r.configured && r.verified;
  return {
    ...r,
    provider,
    lastSuccessAt: lastSuccess.get(provider) ?? null,
    lastFailure: lastFailure.get(provider) ?? null,
    requiredAction: usable ? null : PROVIDER_REQUIRED_ACTION[provider],
  };
}

/**
 * Runs (or returns the cached) connection check for a deploy provider.
 * A real network probe happens at most once per CHECK_TTL_MS per provider;
 * cache hits perform ZERO provider calls and write NO audit row. Every real
 * check is audited as 'integration.health_checked' so the integrations
 * registry picks it up as lastHealthCheck.
 */
export async function verifyProviderConnection(
  db: SupabaseClient | null,
  actor: SystemActor | null,
  provider: DeployProviderId,
  opts: { force?: boolean } = {},
): Promise<ProviderVerification> {
  const cached = cache.get(provider);
  if (!opts.force && cached && Date.now() - cached.at < CHECK_TTL_MS) {
    return cached.result;
  }

  const raw = provider === "vercel" ? await verifyVercelConnection() : await verifyGithubConnection();

  // Record outcome BEFORE building the result so lastSuccessAt/lastFailure
  // reflect this check.
  if (raw.verified) lastSuccess.set(provider, raw.checkedAt);
  else if (raw.configured) lastFailure.set(provider, raw.detail ?? "check failed");
  else lastFailure.set(provider, `missing env: ${raw.missing.join(", ")}`);

  const result = toVerification(provider, raw);
  cache.set(provider, { at: Date.now(), result });

  await systemAudit(db, {
    actor: actor ?? { id: "system", role: "system" },
    action: "integration.health_checked",
    resource: `integration:${provider}`,
    detail: {
      status: result.verified ? "operational" : result.configured ? "degraded" : "unconfigured",
      latencyMs: result.latencyMs,
      detail: (result.detail ?? result.requiredAction ?? "").slice(0, 200),
      capabilities: result.capabilities.slice(0, 12),
    },
  });

  return result;
}

/** Cached verification only — never triggers a network call. */
export function cachedProviderVerification(provider: DeployProviderId): ProviderVerification | null {
  return cache.get(provider)?.result ?? null;
}

/** Test hook — clears module memory between cases. */
export function __resetDeployVerifyCache(): void {
  cache.clear();
  lastSuccess.clear();
  lastFailure.clear();
}

/* ── Static readiness (no network) ─────────────────────────────────────── */

export type ProviderReadiness = {
  provider: DeployProviderId;
  configured: boolean;
  missing: string[];
  requiredAction: string;
};

/** Env-gate snapshot for SSR cards — safe to call on every page render. */
export function deployProviderReadiness(provider: DeployProviderId): ProviderReadiness {
  const gate = provider === "vercel" ? vercelGate() : githubGate();
  return {
    provider,
    configured: gate.configured,
    missing: gate.missing,
    requiredAction: PROVIDER_REQUIRED_ACTION[provider],
  };
}
