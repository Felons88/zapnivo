import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { isCampaignDeliverable, campaignTargetsKiosk } from "@/lib/ads/eligibility";
import { reportError } from "@/lib/observability";

/**
 * Authenticated creative delivery — GET /api/kiosks/creative?id=<uuid>
 * Re-verifies campaign eligibility for the requesting station on EVERY fetch, then
 * redirects to a 5-minute signed URL in the private ad-creatives bucket. Text
 * creatives return JSON directly. Never exposes storage_path or serves unpaid ads.
 */
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const idSchema = z.string().uuid();

export async function GET(req: Request) {
  const secret = process.env.KIOSK_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const creativeId = idSchema.safeParse(url.searchParams.get("id"));
  const stationId = url.searchParams.get("station_id") ?? "";
  if (!creativeId.success || !/^[A-Za-z0-9_-]{3,40}$/.test(stationId)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 422 });
  }

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const [{ data: kiosk }, { data: creative }] = await Promise.all([
    db.from("kiosks").select("id,venue_id,venues(id,city,state,venue_type)").eq("station_id", stationId).maybeSingle(),
    db.from("ad_creatives").select("id,campaign_id,kind,storage_path,mime,headline,body,destination_url,status").eq("id", creativeId.data).maybeSingle(),
  ]);
  if (!kiosk || !creative || creative.status !== "approved") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: campaign } = await db.from("advertising_campaigns")
    .select("id,status,payment_status,targeting,schedule,starts_at,ends_at")
    .eq("id", creative.campaign_id).maybeSingle();
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const venue = (kiosk as { venues?: { id: string; city: string | null; venue_type: string | null } | { id: string; city: string | null; venue_type: string | null }[] | null }).venues;
  const venueRow = Array.isArray(venue) ? venue[0] ?? null : venue ?? null;
  const eligible = isCampaignDeliverable(campaign as Parameters<typeof isCampaignDeliverable>[0], new Date())
    && await campaignTargetsKiosk(db, campaign as Parameters<typeof campaignTargetsKiosk>[1], { id: kiosk.id, venue_id: kiosk.venue_id }, venueRow);
  if (!eligible) return NextResponse.json({ error: "Not available" }, { status: 403 });

  if (creative.kind === "text") {
    return NextResponse.json({ kind: "text", headline: creative.headline, body: creative.body, destination_url: creative.destination_url });
  }
  if (!creative.storage_path) return NextResponse.json({ error: "Creative unavailable" }, { status: 404 });

  const { data: signed, error } = await db.storage.from("ad-creatives").createSignedUrl(creative.storage_path, 300);
  if (error || !signed?.signedUrl) { reportError(error ?? new Error("signed_url_failed"), { route: "kiosks/creative" }); return NextResponse.json({ error: "Creative unavailable" }, { status: 502 }); }
  return NextResponse.redirect(signed.signedUrl, 302);
}
