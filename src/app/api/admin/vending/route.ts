import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { loadVendingOpsDashboard } from "@/lib/vending-ops";

/** Staff JSON feed for the /admin/vending-ops dashboard. Sections degrade honestly. */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const dashboard = await loadVendingOpsDashboard(db);
  return NextResponse.json(dashboard);
}
