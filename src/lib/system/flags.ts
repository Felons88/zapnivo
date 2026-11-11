import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Feature-flag control plane (system_feature_flags).
 *
 * IMPORTANT — honest semantics: these rows are control-plane METADATA + audit
 * trail. Toggling a flag records intent and who changed it; it does NOT change
 * runtime behavior. Actual behavior is still governed by env vars / code paths
 * (e.g. giftSalesEnabled(), KIOSK_ADAPTER, Stripe config). Later stages may wire
 * specific flags to real readers — until then the UI says so explicitly.
 */

export type FeatureFlag = {
  key: string;
  environment: string;
  enabled: boolean;
  description: string;
  owner: string;
  prerequisites: unknown;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
};

export async function listFeatureFlags(db: SupabaseClient, environment?: string): Promise<FeatureFlag[]> {
  let q = db.from("system_feature_flags").select("key,environment,enabled,description,owner,prerequisites,updated_by,updated_at,created_at").order("key");
  if (environment) q = q.eq("environment", environment);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as FeatureFlag[];
}

export type FlagToggleResult =
  | { ok: true; flag: FeatureFlag }
  | { ok: false; status: number; error: string };

/**
 * Toggles a flag row (upsert) and writes a system audit event. Fails closed on
 * unknown keys? No — new keys are allowed (that's how flags get added), but the
 * caller's permission (system.flags.manage) is enforced by the route.
 */
export async function setFeatureFlag(
  db: SupabaseClient,
  actor: SystemActor,
  input: { key: string; enabled: boolean; environment?: string; description?: string },
): Promise<FlagToggleResult> {
  const key = input.key.trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,80}$/i.test(key)) return { ok: false, status: 400, error: "Invalid flag key" };
  const environment = input.environment ?? "production";
  const { data: existing } = await db
    .from("system_feature_flags")
    .select("key,description,owner,prerequisites")
    .eq("key", key)
    .maybeSingle();
  const prior = existing as { description?: string; owner?: string; prerequisites?: unknown } | null;
  const { data, error } = await db
    .from("system_feature_flags")
    .upsert(
      {
        key,
        environment,
        enabled: input.enabled,
        description: input.description ?? prior?.description ?? "",
        owner: prior?.owner ?? "platform",
        prerequisites: prior?.prerequisites ?? [],
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select("key,environment,enabled,description,owner,prerequisites,updated_by,updated_at,created_at")
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "flag update failed" };
  await systemAudit(db, {
    actor,
    action: input.enabled ? "flag.enabled" : "flag.disabled",
    resource: `feature_flag:${key}`,
    detail: { flag: key, environment, note: "metadata only — env vars still govern runtime behavior" },
  });
  return { ok: true, flag: data as FeatureFlag };
}
