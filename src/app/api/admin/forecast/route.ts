import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { loadForecastInput } from "@/lib/forecast-data";
import { serviceClient } from "@/lib/supabase";

/**
 * GET /api/admin/forecast?horizon=7|30
 * Staff-only demand forecast over real rental starts. Every number is an
 * estimate from src/lib/forecast.ts — see `caveat` / `method` in the payload.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const raw = new URL(req.url).searchParams.get("horizon") ?? "7";
  const horizon = raw === "30" ? 30 : raw === "7" ? 7 : null;
  if (horizon === null) {
    return NextResponse.json({ error: "horizon must be 7 or 30" }, { status: 400 });
  }

  try {
    const data = await loadForecastInput(db, { horizon });
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      horizon,
      window: { start: data.windowStart, end: data.windowEnd, observedDays: data.networkAnalysis.days },
      truncated: data.truncated,
      network: {
        status: data.networkAnalysis.status,
        reason: data.networkAnalysis.reason,
        method: data.networkAnalysis.method,
        confidence: data.networkAnalysis.confidence,
        caveat: data.networkAnalysis.caveat,
        totalStarts: data.networkAnalysis.total,
        meanPerDay: data.networkAnalysis.meanPerDay,
        ma7Latest: data.networkAnalysis.ma7.filter((m) => m.value !== null).at(-1)?.value ?? null,
        ma30Latest: data.networkAnalysis.ma30.filter((m) => m.value !== null).at(-1)?.value ?? null,
        trend: data.networkAnalysis.trend,
        seasonal: data.networkAnalysis.seasonal,
        history: data.networkSeries,
        forecast: data.networkForecast,
      },
      stations: data.stations.map((s) => ({
        stationId: s.stationId,
        label: s.label,
        status: s.analysis.status,
        reason: s.analysis.reason,
        method: s.analysis.method,
        confidence: s.analysis.confidence,
        totalStarts: s.analysis.total,
        meanPerDay: s.analysis.meanPerDay,
        trendR2: s.analysis.trend?.r2 ?? null,
        trendSlopePerDay: s.analysis.trend?.slopePerDay ?? null,
        forecast: s.forecast,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Forecast failed — rental data could not be loaded." }, { status: 500 });
  }
}
