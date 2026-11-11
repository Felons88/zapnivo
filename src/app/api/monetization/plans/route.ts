import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/monetization/plans — active membership plans + prepaid packages for the
 * signed-in customer portal. Session required (customer.zapnivo.com); prices always
 * come from the DB rows, never hardcoded.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const [plans, packages] = await Promise.all([
    db.from("membership_plans")
      .select("id,name,description,price_cents,interval,benefit")
      .eq("active", true).order("price_cents", { ascending: true }),
    db.from("prepaid_packages")
      .select("id,name,description,kind,units,price_cents,validity_days,sort")
      .eq("active", true).order("sort", { ascending: true }).order("price_cents", { ascending: true }),
  ]);

  if (plans.error || packages.error) {
    recordLog("warning", "monetization_catalog_failed", {
      service: "monetization", route: "api/monetization/plans",
      attrs: { err: (plans.error ?? packages.error)?.message?.slice(0, 160) },
    });
    return NextResponse.json({ error: "Catalog isn't available right now." }, { status: 503 });
  }
  return NextResponse.json({ plans: plans.data ?? [], packages: packages.data ?? [] });
}
