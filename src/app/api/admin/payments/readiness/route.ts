import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { paymentReadiness } from "@/lib/payments/readiness";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/payments/readiness — staff-only payment readiness checklist.
 * Returns configuration booleans and counts only; no secret values are ever exposed.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  const db = serviceClient();
  // db may be null — readiness reports product/reconciliation checks as unknown then.
  const readiness = await paymentReadiness(db);
  return NextResponse.json(readiness, { headers: { "Cache-Control": "no-store" } });
}
