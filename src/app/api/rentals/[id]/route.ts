import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { triggerRentalReturned, triggerRentalStarted } from "@/lib/email-triggers";
import { PRICING_V1 } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";

/** Staff rental lifecycle actions. Dispense/return confirmations fire the branded customer emails. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { id } = await params;
  const form = req.headers.get("content-type")?.includes("json")
    ? await req.json().catch(() => ({}))
    : Object.fromEntries(await req.formData());
  const action = String((form as { action?: string }).action ?? "");
  const done = (state: string) =>
    req.headers.get("content-type")?.includes("json")
      ? NextResponse.json({ ok: true, state })
      : NextResponse.redirect(new URL("/admin/rentals", req.url), 303);
  const now = new Date();

  if (action === "dispense") {
    const deadline = new Date(now.getTime() + PRICING_V1.nonReturnAfterHours * 3600_000);
    const { error } = await db.from("rentals").update({ state: "active", dispensed_at: now.toISOString(), non_return_deadline: deadline.toISOString() }).eq("id", id).eq("state", "dispense_pending");
    if (error) return NextResponse.json({ error: "Couldn't confirm dispense." }, { status: 500 });
    await triggerRentalStarted(id);
    return done("active");
  }

  if (action === "return") {
    const { error } = await db.from("rentals").update({ state: "returned", returned_at: now.toISOString() }).eq("id", id).in("state", ["active", "unreturned"]);
    if (error) return NextResponse.json({ error: "Couldn't record the return." }, { status: 500 });
    await triggerRentalReturned(id);
    return done("returned");
  }

  return NextResponse.json({ error: "action must be dispense or return" }, { status: 400 });
}
