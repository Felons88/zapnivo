import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { GIFT_LAUNCH_CHECKLIST, giftLaunchStatus } from "@/lib/gift-launch";

/**
 * GET /api/admin/gifts/launch-status — staff-only read of the gift-card launch
 * gate: the honest checklist plus derived technical/legal/payments status.
 * Read-only; nothing here enables sales.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  return NextResponse.json(
    { ...giftLaunchStatus(), checklist: GIFT_LAUNCH_CHECKLIST },
    { headers: { "Cache-Control": "no-store" } },
  );
}
