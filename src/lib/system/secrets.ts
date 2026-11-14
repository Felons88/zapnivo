import { listSecrets, SECRET_BY_ENV_VAR, type SecretRow } from "./integrations";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Secret-management read model for /system/secrets (Phase 4.4).
 *
 * HONESTY CONTRACT:
 *  - METADATA ONLY. This module never reads env VALUES — it wraps
 *    listSecrets() (names, purposes, configured booleans, last rotation
 *    REQUEST timestamp from system_audit_events) and adds classification.
 *    There is no code path here that returns a secret value.
 *  - Scope: presence is observed in the CURRENT runtime only. Per-environment
 *    (production/preview/development) scoping is a Vercel-side setting this
 *    app cannot read — reported honestly, never guessed.
 *  - Expiry: env vars carry no creation/rotation-age metadata, so expiry
 *    reminders are NOT tracked — stated as "none", not faked.
 *  - "lastRotatedAt" is the last rotation REQUEST audit timestamp — a request
 *    is not proof a rotation completed. Labeled accordingly everywhere.
 */

export type SecretSensitivity =
  /** Live credential — compromise enables impersonation/access. */
  | "credential"
  /** Non-secret configuration value misfiled in the registry for completeness. */
  | "config"
  /** NEXT_PUBLIC_* value — shipped to browsers by design; still tracked. */
  | "publishable";

/**
 * Classifies a registry entry. Heuristic, deliberately conservative:
 *  - NEXT_PUBLIC_* prefix → publishable (browser-visible by design).
 *  - rotation/purpose text containing "Not a secret" → config.
 *  - everything else → credential.
 */
export function classifySecret(meta: { envVar: string; purpose: string; rotation: string }): SecretSensitivity {
  if (meta.envVar.startsWith("NEXT_PUBLIC_")) return "publishable";
  if (/not a secret/i.test(meta.rotation) || /not a secret/i.test(meta.purpose)) return "config";
  return "credential";
}

export const SECRET_SCOPE_NOTE =
  "Configured state is observed in the CURRENT runtime environment only. Per-environment " +
  "(production / preview / development) scoping is a Vercel env-var setting this app cannot " +
  "read — verify scopes in Vercel → Project → Settings → Environment Variables.";

export const SECRET_EXPIRY_NOTE =
  "No expiry reminders: env vars carry no creation/rotation-age metadata in this system, " +
  "so credential age cannot be computed. 'Last rotation' below is the last rotation REQUEST " +
  "(audit event), not proof a rotation completed.";

export type SecretInventoryRow = SecretRow & {
  sensitivity: SecretSensitivity;
  scopeNote: typeof SECRET_SCOPE_NOTE;
  /** 'requested' = at least one rotation request audit event exists. */
  rotationState: "never_requested" | "requested";
  expiryTracking: "none";
};

/**
 * Enriched credential inventory — same redaction guarantees as listSecrets
 * (no values anywhere), plus classification and honest scope/expiry notes.
 */
export async function secretInventory(db: SupabaseClient | null): Promise<SecretInventoryRow[]> {
  const rows = await listSecrets(db);
  return rows.map((r) => {
    const meta = SECRET_BY_ENV_VAR.get(r.envVar);
    return {
      ...r,
      sensitivity: meta ? classifySecret(meta) : "credential",
      scopeNote: SECRET_SCOPE_NOTE,
      rotationState: r.lastRotatedAt ? "requested" : "never_requested",
      expiryTracking: "none" as const,
    };
  });
}

/**
 * Post-rotation verification checklist shown after a rotation request is
 * approved. The env write itself is always a manual Vercel step — this app
 * never writes env vars and never stores the value.
 */
export const POST_ROTATION_CHECKLIST: readonly string[] = [
  "Confirm the change request shows approved (risk: high — decided by an authorized reviewer).",
  "Update the env var in Vercel for EVERY environment it is scoped to (production + preview as needed).",
  "Redeploy — env var changes only take effect on a new deployment.",
  "Verify once: run the integration health check or exercise the feature that uses the credential.",
  "Revoke/expire the OLD credential at the provider so it can no longer be used.",
  "Expect the 'last rotation request' timestamp to update only when the NEXT request is filed — there is no auto-close on completion.",
];

/**
 * Redaction assertion used by tests and callable defensively: verifies an
 * inventory payload contains ONLY the allowlisted metadata keys — any key
 * that could carry a value (value/secret/token/key material fields) fails.
 */
const FORBIDDEN_KEYS = /^(value|secret_value|new_value|token|password|api_key|private_key|authorization|cookie)$/i;

export function assertInventoryRedacted(rows: readonly Record<string, unknown>[]): { ok: true } | { ok: false; offendingKeys: string[] } {
  const offending = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (FORBIDDEN_KEYS.test(k)) offending.add(k);
    }
  }
  return offending.size ? { ok: false, offendingKeys: [...offending] } : { ok: true };
}
