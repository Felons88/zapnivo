import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard } from "../../_shared";
import { mapboxConfigured, mapboxRetrieve, mapVenueType } from "@/lib/mapbox";

const querySchema = z.object({
  id: z.string().min(8).max(120),
  session: z.string().uuid(),
});

/**
 * GET /api/system/mapbox/retrieve?id=&session=
 * Fetches full place details for a selected suggestion and pre-maps the
 * Zapnivo venue_type. Fields Mapbox doesn't provide are returned as null —
 * the form leaves them editable rather than fabricating values.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  if (!mapboxConfigured()) {
    return NextResponse.json({ configured: false, venue: null }, { status: 503 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ id: url.searchParams.get("id"), session: url.searchParams.get("session") });
  if (!parsed.success) return NextResponse.json({ error: "id and a uuid session token are required" }, { status: 400 });

  const venue = await mapboxRetrieve(parsed.data.id, parsed.data.session);
  if (!venue) return NextResponse.json({ error: "Could not load that place from Mapbox." }, { status: 502 });

  return NextResponse.json({
    configured: true,
    venue: { ...venue, venue_type: mapVenueType(venue.categories) },
  });
}
