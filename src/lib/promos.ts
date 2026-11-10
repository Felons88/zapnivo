import type { SupabaseClient } from "@supabase/supabase-js";

export type PromoRow = {
  code: string; percent_off: number | string | null; amount_off_cents: number | null; active: boolean;
  starts_at: string | null; expires_at: string | null; max_redemptions: number | null; redemptions: number;
};

export const PROMO_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Pure usability check (does not reserve a redemption). */
export function promoUsable(p: PromoRow, now = new Date()): boolean {
  if (!p.active) return false;
  if (p.starts_at && new Date(p.starts_at) > now) return false;
  if (p.expires_at && new Date(p.expires_at) <= now) return false;
  if (p.max_redemptions !== null && p.redemptions >= p.max_redemptions) return false;
  return true;
}

export async function lookupPromo(db: SupabaseClient, code: string): Promise<PromoRow | null> {
  if (!PROMO_CODE_RE.test(code)) return null;
  const { data } = await db.from("promo_codes").select("*").eq("code", code).maybeSingle();
  return (data as PromoRow | null) ?? null;
}

/** Atomically reserves one redemption (single conditional UPDATE inside redeem_promo). Null = not redeemable. */
export async function redeemPromo(db: SupabaseClient, code: string): Promise<PromoRow | null> {
  const { data, error } = await db.rpc("redeem_promo", { p_code: code });
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as PromoRow | null;
  return row && row.code ? row : null;
}

export async function releasePromo(db: SupabaseClient, code: string) {
  await db.rpc("release_promo", { p_code: code });
}
