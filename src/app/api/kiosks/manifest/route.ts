import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/lib/supabase";
import { isCampaignDeliverable, campaignTargetsKiosk } from "@/lib/ads/eligibility";
import { reportError, recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Ad manifest for a kiosk — GET /api/kiosks/manifest?station_id=XXX
 * Auth: Authorization: Bearer $KIOSK_INGEST_SECRET (same secret as device ingest).
 * Returns only paid, in-window, targeting-matched, approved creatives. Records a
 * deduped manifest_delivered event per campaign (evidence of delivery, NOT an impression).
 */
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const MAX_CREATIVES = 20;
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

export async function GET(req: Request) {
  // Bearer endpoints still do multi-query work per call — bound per-IP abuse (D10).
  if (!rateLimit(`kiosk-manifest:${clientIp(req)}`, 60, 60_000).ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const secret = process.env.KIOSK_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const stationId = new URL(req.url).searchParams.get("station_id") ?? "";
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(stationId)) return NextResponse.json({ error: "Invalid station_id" }, { status: 422 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const { data: kiosk } = await db.from("kiosks")
    .select("id,station_id,state,venue_id,venues(id,city,state,venue_type)")
    .eq("station_id", stationId).maybeSingle();
  if (!kiosk) return NextResponse.json({ error: "Unknown station" }, { status: 404 });

  const venue = (kiosk as { venues?: { id: string; city: string | null; venue_type: string | null } | { id: string; city: string | null; venue_type: string | null }[] | null }).venues;
  const venueRow = Array.isArray(venue) ? venue[0] ?? null : venue ?? null;

  const { data: campaigns, error } = await db.from("advertising_campaigns")
    .select("id,name,status,payment_status,targeting,schedule,starts_at,ends_at,activated_at")
    .in("status", ["scheduled", "live"])
    .eq("payment_status", "paid")
    .limit(100);
  if (error) { reportError(error, { route: "kiosks/manifest" }); return NextResponse.json({ error: "Manifest unavailable" }, { status: 500 }); }

  const now = new Date();
  const eligible = [];
  for (const c of (campaigns ?? []) as Parameters<typeof isCampaignDeliverable>[0][]) {
    if (!isCampaignDeliverable(c, now)) continue;
    if (!(await campaignTargetsKiosk(db, c, { id: kiosk.id, venue_id: kiosk.venue_id }, venueRow))) continue;
    eligible.push(c.id);
  }
  const serveLog = (placements: number) =>
    recordLog("info", "ad_manifest_served", { service: "ads", route: "kiosks/manifest", attrs: { stationId, eligibleCampaigns: eligible.length, placements } });
  if (!eligible.length) { serveLog(0); return NextResponse.json({ station_id: stationId, generated_at: now.toISOString(), placements: [] }); }

  const { data: creatives } = await db.from("ad_creatives")
    .select("id,campaign_id,kind,mime,storage_path,headline,body,destination_url,width,height,duration_ms,version")
    .in("campaign_id", eligible).eq("status", "approved")
    .order("created_at", { ascending: true }).limit(MAX_CREATIVES);

  const placements = ((creatives ?? []) as Record<string, unknown>[]).map((cr) => ({
    campaign_id: cr.campaign_id,
    creative_id: cr.id,
    kind: cr.kind,
    version: cr.version,
    mime: cr.mime,
    width: cr.width, height: cr.height, duration_ms: cr.duration_ms,
    headline: cr.headline, body: cr.body, destination_url: cr.destination_url,
    creative_url: `/api/kiosks/creative?id=${cr.id}`,
  }));

  // Delivery evidence — dedupe per kiosk/campaign/hour bucket.
  const bucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  for (const cid of eligible) {
    await db.from("ad_events").insert({
      campaign_id: cid, kiosk_id: kiosk.id, kind: "manifest_delivered",
      dedupe_key: `manifest:${kiosk.id}:${cid}:${bucket}`,
    }).then(() => undefined, () => undefined); // 23505 duplicate = already recorded
  }

  serveLog(placements.length);
  return NextResponse.json({ station_id: stationId, generated_at: now.toISOString(), placements });
}
