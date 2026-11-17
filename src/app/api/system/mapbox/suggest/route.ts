import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard } from "../../_shared";
import { mapboxConfigured, mapboxSuggest } from "@/lib/mapbox";

const querySchema = z.object({
  q: z.string().trim().min(2).max(200),
  session: z.string().uuid(),
});

/**
 * GET /api/system/mapbox/suggest?q=&session=
 * Debounced admin autocomplete. A missing/invalid token degrades to
 * `configured:false` so the UI falls back to manual entry honestly.
 */
export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  if (!mapboxConfigured()) {
    return NextResponse.json({ configured: false, suggestions: [] }, { status: 503 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ q: url.searchParams.get("q"), session: url.searchParams.get("session") });
  if (!parsed.success) return NextResponse.json({ error: "q (2+ chars) and a uuid session token are required" }, { status: 400 });

  const suggestions = await mapboxSuggest(parsed.data.q, parsed.data.session);
  if (suggestions === null) {
    return NextResponse.json({ error: "Mapbox lookup failed — enter the venue manually." }, { status: 502 });
  }
  return NextResponse.json({ configured: true, suggestions });
}
