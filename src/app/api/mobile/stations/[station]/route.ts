import { NextResponse } from "next/server";
import { PRICING_SELECT, pricingFromRow, type PricingRow } from "@/lib/billing";
import { decideAvailability, type KioskVenueRow } from "@/lib/customer";
import { stationMaintenanceBlock } from "@/lib/kiosk/availability";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const validId = /^[A-Za-z0-9_-]{3,40}$/;

/** QR/manual lookup works even before a venue has map coordinates. Checkout rechecks every gate. */
export async function GET(_req: Request, { params }: { params: Promise<{ station: string }> }) {
  const { station } = await params;
  if (!validId.test(station)) return NextResponse.json({ error: "Invalid station ID." }, { status: 400 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });

  const { data, error } = await db.from("kiosks")
    .select("id,station_id,state,installed_at,test_mode,venues(name,street,city,state,zip,hours,published,lat,lng)")
    .eq("station_id", station).maybeSingle();
  if (error) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });
  const row = data as unknown as (KioskVenueRow & { id: string; venues: NonNullable<KioskVenueRow>['venues'] & { lat: number | null; lng: number | null } }) | null;
  const availability = decideAvailability(row, true);
  if (!availability.ok) return NextResponse.json({ error: "This station is not available for rentals." }, { status: 404 });

  const testMode = row!.test_mode === true;
  // Test stations act as live: full slot capacity and the latest pricing
  // version (approved or draft) so the app can render a complete rental UI.
  const slotsQuery = db.from("kiosk_slots").select("slot_number", { count: "exact", head: true }).eq("kiosk_id", row!.id);
  const priceQuery = db.from("pricing_versions").select(PRICING_SELECT);
  const [slots, priceResult, maintenance] = await Promise.all([
    (testMode ? slotsQuery : slotsQuery.eq("state", "ready")),
    (testMode ? priceQuery : priceQuery.eq("approved", true))
      .order("effective_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    stationMaintenanceBlock(db, station),
  ]);
  if (slots.error || priceResult.error) return NextResponse.json({ error: "Station service is unavailable." }, { status: 503 });
  const approved = priceResult.data ? pricingFromRow(priceResult.data as PricingRow) : null;
  const venue = row!.venues;
  return NextResponse.json({
    station: {
      id: station, name: availability.venueName, address: availability.address,
      city: venue?.city ?? "", state: venue?.state ?? "", hours: availability.hours,
      lat: venue?.lat ?? null, lng: venue?.lng ?? null,
      ready_banks: Math.max(0, slots.count ?? 0),
      // Test mode acts as a live station: rentable whenever not under
      // maintenance. Checkout re-validates payment, promos, and rental limits.
      rentals_available: !maintenance && (testMode || (Boolean(approved) && (slots.count ?? 0) > 0)),
    },
    pricing: approved ? {
      first_hour_cents: approved.firstHourCents,
      additional_hour_cents: approved.additionalHourCents,
      non_return_max_cents: approved.nonReturnMaxCents,
      non_return_after_hours: approved.nonReturnAfterHours,
    } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
