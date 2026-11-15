import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { parsePeriodDays, periodWindow } from "@/lib/admin-finance";
import { loadRevenueAssurance } from "@/lib/revenue-assurance";
import { serviceClient } from "@/lib/supabase";

/** Revenue assurance aggregate — staff-readable JSON mirror of /admin/revenue. Read-only; no audit needed. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const days = parsePeriodDays(new URL(req.url).searchParams.get("days"));
  const window = periodWindow(days);
  try {
    const data = await loadRevenueAssurance(db, window);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load revenue assurance" }, { status: 500 });
  }
}
