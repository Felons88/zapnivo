import { NextResponse } from "next/server";
import { getBearerUser, isStaff } from "@/lib/auth";
import { PRICING_SELECT, pricingFromRow, type PricingRow } from "@/lib/billing";
import { getStations } from "@/lib/stations";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Public, read-only mobile view of the same verified stations and approved prices used by checkout. */
export async function GET(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });

  // Test-mode kiosks are never listed publicly; staff and flagged testers get
  // them so the pre-launch app can exercise the full flow on lab hardware.
  const user = await getBearerUser(req).catch(() => null);
  let includeTest = false;
  if (user) {
    if (isStaff(user)) includeTest = true;
    else {
      const { data: prof } = await db.from("profiles").select("is_tester").eq("id", user.id).maybeSingle();
      includeTest = (prof as { is_tester?: boolean } | null)?.is_tester === true;
    }
  }

  const [stations, priceResult] = await Promise.all([
    getStations({ includeTest }),
    db.from("pricing_versions").select(PRICING_SELECT)
      .eq("approved", true)
      .order("effective_at", { ascending: false, nullsFirst: false })
      .limit(1).maybeSingle(),
  ]);
  if (priceResult.error) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });

  let approved = priceResult.data ? pricingFromRow(priceResult.data as PricingRow) : null;
  // Test checkout prices from the latest version even before approval — mirror
  // that here so testers see the same rates the quote will actually use.
  if (!approved && includeTest) {
    const { data: latest } = await db.from("pricing_versions").select(PRICING_SELECT)
      .order("effective_at", { ascending: false, nullsFirst: false })
      .limit(1).maybeSingle();
    if (latest) approved = pricingFromRow(latest as PricingRow);
  }
  return NextResponse.json({
    stations,
    pricing: approved ? {
      first_hour_cents: approved.firstHourCents,
      additional_hour_cents: approved.additionalHourCents,
      non_return_max_cents: approved.nonReturnMaxCents,
      non_return_after_hours: approved.nonReturnAfterHours,
      hold_cents: approved.holdCentsPerBank,
    } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
