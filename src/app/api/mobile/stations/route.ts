import { NextResponse } from "next/server";
import { PRICING_SELECT, pricingFromRow, type PricingRow } from "@/lib/billing";
import { getStations } from "@/lib/stations";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Public, read-only mobile view of the same verified stations and approved prices used by checkout. */
export async function GET() {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });

  const [stations, priceResult] = await Promise.all([
    getStations(),
    db.from("pricing_versions").select(PRICING_SELECT)
      .eq("approved", true)
      .order("effective_at", { ascending: false, nullsFirst: false })
      .limit(1).maybeSingle(),
  ]);
  if (priceResult.error) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });

  const approved = priceResult.data ? pricingFromRow(priceResult.data as PricingRow) : null;
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
