import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { fetchFinanceData, groupByVenue, parsePeriodDays, periodWindow } from "@/lib/admin-finance";
import { serviceClient } from "@/lib/supabase";

/** Per-venue finance breakdown — admin only. Honest zeros; venues with no activity are absent. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const days = parsePeriodDays(new URL(req.url).searchParams.get("days"));
  const window = periodWindow(days);
  const data = await fetchFinanceData(db, window);
  const venues = groupByVenue(data);
  return NextResponse.json({ period: window, count: venues.length, venues }, { headers: { "Cache-Control": "no-store" } });
}
