import type { SupabaseClient } from "@supabase/supabase-js";

export type WalletStats = {
  loadedTodayCents: number;
  loaded30dCents: number;
  paidTopups30d: number;
  failedTopups30d: number;
  pendingTopups: number;
  outstandingCents: number;
  activeCards: number;
  lastPaidAt: string | null;
};

/** Dashboard rollup for the prepaid wallet. Any failed read yields null so the UI never shows invented zeros. */
export async function loadWalletStats(db: SupabaseClient, now = new Date()): Promise<WalletStats | null> {
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const [topups, grants, cards] = await Promise.all([
    db.from("wallet_topups").select("amount_cents,status,created_at,paid_at").gte("created_at", since30).limit(5000),
    db.from("entitlement_grants").select("remaining,reserved,expires_at").eq("unit", "cent").eq("status", "active").limit(20000),
    db.from("prepaid_cards").select("id", { count: "exact", head: true }).eq("status", "active"),
  ]);
  if (topups.error || grants.error) return null;
  const rows = (topups.data ?? []) as { amount_cents: number; status: string; created_at: string; paid_at: string | null }[];
  const paid = rows.filter((r) => r.status === "paid");
  const nowMs = now.getTime();
  return {
    loadedTodayCents: paid.filter((r) => r.paid_at && r.paid_at >= startOfDay.toISOString()).reduce((s, r) => s + r.amount_cents, 0),
    loaded30dCents: paid.reduce((s, r) => s + r.amount_cents, 0),
    paidTopups30d: paid.length,
    failedTopups30d: rows.filter((r) => r.status === "failed").length,
    pendingTopups: rows.filter((r) => r.status === "pending").length,
    outstandingCents: ((grants.data ?? []) as { remaining: number; reserved: number | null; expires_at: string | null }[])
      .filter((g) => !g.expires_at || Date.parse(g.expires_at) > nowMs)
      .reduce((s, g) => s + Math.max(0, g.remaining - (g.reserved ?? 0)), 0),
    activeCards: cards.error ? 0 : cards.count ?? 0,
    lastPaidAt: paid.map((r) => r.paid_at).filter((x): x is string => !!x).sort().pop() ?? null,
  };
}
