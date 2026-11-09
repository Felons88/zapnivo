import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

/** A staff member's own alert preferences (offline, low-battery, partner inquiries). */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user) || !/^[0-9a-f-]{36}$/i.test(user!.id)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const f = await req.formData();
  const { error } = await db.from("notification_prefs").upsert({
    profile_id: user!.id,
    offline_alerts: f.get("offline_alerts") === "on",
    low_battery_alerts: f.get("low_battery_alerts") === "on",
    new_partner_inquiries: f.get("new_partner_inquiries") === "on",
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
  return NextResponse.redirect(new URL("/admin/users?prefs=saved", req.url), 303);
}
