import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { issueReturnCommand } from "@/lib/kiosk/dispatch";
import { recordLog } from "@/lib/observability";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  station_id: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
});

const OPEN_RETURN_STATES = ["active", "return_pending", "overdue", "unreturned"];

/**
 * POST /api/mobile/rentals/return — the customer scanned a return dock's code.
 * Physical truth still comes from the kiosk's own dock event; this endpoint
 * only queues a simulated dock sequence when the scanned station is a
 * test-mode kiosk (no hardware exists there to emit it). Every branch reports
 * what actually happened — `simulated` is never implied for real hardware.
 */
export async function POST(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-return:${c.user.id}`, 20, 10 * 60_000).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid station code." }, { status: 422 });

  const { data: rental } = await c.db.from("rentals")
    .select("id")
    .or(`customer_id.eq.${c.user.id},renter_profile.eq.${c.user.id}`)
    .in("state", OPEN_RETURN_STATES)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!rental) {
    return NextResponse.json({ ok: true, active_rental: false, queued: false, simulated: false });
  }

  try {
    const res = await issueReturnCommand(c.db, (rental as { id: string }).id, parsed.data.station_id);
    if (!res.ok) {
      const status = res.reason === "station_not_found" ? 404 : 409;
      return NextResponse.json({ error: res.reason, queued: false, simulated: false }, { status });
    }
    return NextResponse.json({ ok: true, active_rental: true, queued: res.queued ?? false, simulated: res.simulated ?? false });
  } catch (e) {
    recordLog("error", "return_scan_failed", {
      service: "mobile", route: "/api/mobile/rentals/return",
      attrs: { reason: e instanceof Error ? e.message : "unknown" },
    });
    // The physical dock remains the source of truth — a sim failure must not
    // break the return screen; it keeps polling for the real dock event.
    return NextResponse.json({ ok: true, active_rental: true, queued: false, simulated: false });
  }
}
