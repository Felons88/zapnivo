import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { activeMembership, balance, listGrants } from "@/lib/monetization/entitlements";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type PlanRef = { name: string; interval: string; price_cents: number };
type MembershipRow = {
  id: string; plan_id: string; status: string; current_period_end: string | null;
  cancel_at_period_end: boolean; stripe_subscription_id: string | null; created_at: string;
};
type PurchaseRow = {
  id: string; package_id: string; status: string; amount_cents: number;
  created_at: string; paid_at: string | null;
};

/**
 * GET /api/monetization/benefits — the signed-in customer's entitlement snapshot:
 * balance by unit, grant history, active membership (+ plan), membership history,
 * and prepaid package purchases. Session required.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const [bal, grants, mem, membershipsRes, purchasesRes] = await Promise.all([
    balance(db, user.id),
    listGrants(db, user.id),
    activeMembership(db, user.id),
    db.from("customer_memberships")
      .select("id,plan_id,status,current_period_end,cancel_at_period_end,stripe_subscription_id,created_at")
      .eq("profile_id", user.id).order("created_at", { ascending: false }).limit(20),
    db.from("package_purchases")
      .select("id,package_id,status,amount_cents,created_at,paid_at")
      .eq("profile_id", user.id).order("created_at", { ascending: false }).limit(50),
  ]);

  if (membershipsRes.error || purchasesRes.error) {
    recordLog("warning", "monetization_benefits_failed", {
      service: "monetization", route: "api/monetization/benefits",
      attrs: { err: (membershipsRes.error ?? purchasesRes.error)?.message?.slice(0, 160) },
    });
    return NextResponse.json({ error: "Benefits aren't available right now." }, { status: 503 });
  }

  // Resolve plan/package display names server-side (plain selects, no embed assumptions).
  const planIds = [...new Set([...(mem ? [mem.plan_id] : []), ...((membershipsRes.data ?? []) as MembershipRow[]).map((m) => m.plan_id)])];
  const pkgIds = [...new Set(((purchasesRes.data ?? []) as PurchaseRow[]).map((p) => p.package_id))];
  const [plansRes, pkgsRes] = await Promise.all([
    planIds.length ? db.from("membership_plans").select("id,name,interval,price_cents").in("id", planIds) : Promise.resolve({ data: [], error: null }),
    pkgIds.length ? db.from("prepaid_packages").select("id,name,kind,units,validity_days").in("id", pkgIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const planById = new Map(((plansRes.data ?? []) as (PlanRef & { id: string })[]).map((p) => [p.id, p]));
  const pkgById = new Map(((pkgsRes.data ?? []) as { id: string; name: string; kind: string; units: number; validity_days: number | null }[]).map((p) => [p.id, p]));

  const withPlan = (m: MembershipRow) => ({ ...m, plan: planById.get(m.plan_id) ?? null });
  const membership = mem ? { ...mem, plan: planById.get(mem.plan_id) ?? null } : null;
  const memberships = ((membershipsRes.data ?? []) as MembershipRow[]).map(withPlan);
  const purchases = ((purchasesRes.data ?? []) as PurchaseRow[]).map((p) => ({ ...p, package: pkgById.get(p.package_id) ?? null }));

  return NextResponse.json({
    balance: bal ?? {},
    grants,
    membership,
    memberships,
    purchases,
  });
}
