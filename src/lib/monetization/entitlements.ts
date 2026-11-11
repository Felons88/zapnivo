import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";

/**
 * Entitlement engine client. All mutations go through the security-definer RPCs
 * (grant_entitlement / redeem_entitlement / expire_entitlements) so balance
 * changes are atomic and audited in entitlement_events. Never update
 * entitlement_grants.remaining directly.
 */

export type EntitlementUnit = "rental" | "minute" | "cent";
export type Grant = {
  id: string; kind: string; unit: EntitlementUnit; granted: number; remaining: number;
  expires_at: string | null; status: string; source_type: string | null; source_id: string | null; created_at: string;
};

export async function balance(db: SupabaseClient, profileId: string, unit?: EntitlementUnit) {
  let q = db.from("entitlement_grants").select("unit,remaining,expires_at,status")
    .eq("profile_id", profileId).eq("status", "active");
  if (unit) q = q.eq("unit", unit);
  const { data, error } = await q;
  if (error) { recordLog("warning", "entitlement_balance_failed", { service: "monetization", attrs: { err: error.message.slice(0, 120) } }); return null; }
  const now = Date.now();
  const byUnit: Record<string, number> = {};
  for (const g of (data ?? []) as { unit: string; remaining: number; expires_at: string | null }[]) {
    if (g.expires_at && Date.parse(g.expires_at) <= now) continue;
    byUnit[g.unit] = (byUnit[g.unit] ?? 0) + g.remaining;
  }
  return byUnit as Partial<Record<EntitlementUnit, number>>;
}

export async function listGrants(db: SupabaseClient, profileId: string): Promise<Grant[]> {
  const { data, error } = await db.from("entitlement_grants")
    .select("id,kind,unit,granted,remaining,expires_at,status,source_type,source_id,created_at")
    .eq("profile_id", profileId).order("created_at", { ascending: false }).limit(50);
  if (error) return [];
  return (data ?? []) as Grant[];
}

export async function grant(
  db: SupabaseClient,
  args: { profileId: string; kind: string; unit: EntitlementUnit; amount: number; expiresAt?: string | null;
    sourceType?: string | null; sourceId?: string | null; actor?: string; note?: string | null },
): Promise<{ ok: true; grantId: string } | { ok: false; error: string }> {
  const { data, error } = await db.rpc("grant_entitlement", {
    p_profile: args.profileId, p_kind: args.kind, p_unit: args.unit, p_amount: args.amount,
    p_expires_at: args.expiresAt ?? null, p_source_type: args.sourceType ?? null, p_source_id: args.sourceId ?? null,
    p_actor: args.actor ?? "system", p_note: args.note ?? null,
  });
  if (error) { recordLog("warning", "entitlement_grant_failed", { service: "monetization", attrs: { err: error.message.slice(0, 160) } }); return { ok: false, error: error.message }; }
  return { ok: true, grantId: data as string };
}

export async function redeem(
  db: SupabaseClient,
  args: { profileId: string; unit: EntitlementUnit; amount: number; refType?: string; refId?: string; actor?: string },
): Promise<{ ok: true; grantId: string } | { ok: false; error: "insufficient_entitlement" | "invalid_amount" | string }> {
  const { data, error } = await db.rpc("redeem_entitlement", {
    p_profile: args.profileId, p_unit: args.unit, p_amount: args.amount,
    p_ref_type: args.refType ?? null, p_ref_id: args.refId ?? null, p_actor: args.actor ?? "system",
  });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("insufficient_entitlement")) return { ok: false, error: "insufficient_entitlement" };
    if (msg.includes("invalid_amount")) return { ok: false, error: "invalid_amount" };
    recordLog("warning", "entitlement_redeem_failed", { service: "monetization", attrs: { err: msg.slice(0, 160) } });
    return { ok: false, error: msg.slice(0, 120) };
  }
  return { ok: true, grantId: data as string };
}

export async function expireSweep(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc("expire_entitlements");
  if (error) { recordLog("warning", "entitlement_expire_failed", { service: "monetization", attrs: { err: error.message.slice(0, 160) } }); return 0; }
  return (data as number) ?? 0;
}

/** Active membership for a profile, if any. */
export async function activeMembership(db: SupabaseClient, profileId: string) {
  const { data } = await db.from("customer_memberships")
    .select("id,plan_id,status,current_period_end,cancel_at_period_end")
    .eq("profile_id", profileId).in("status", ["trialing", "active", "past_due"]).order("created_at", { ascending: false }).limit(1);
  return (data?.[0] as { id: string; plan_id: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean } | undefined) ?? null;
}
