import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { isCampaignDeliverable, campaignTargetsKiosk } from "@/lib/ads/eligibility";
import { reportError } from "@/lib/observability";

/**
 * Verified ad engagement ingest — POST /api/kiosks/playback
 * Body: { station_id, events: [{ campaign_id, creative_id?, kind: playback|impression|click, dedupe_key?, at? }] }
 * Auth: Bearer $KIOSK_INGEST_SECRET. Only records events for campaigns that are paid,
 * in-window and targeting this kiosk RIGHT NOW. dedupe_key unique constraint makes
 * retries idempotent. This is the only source of billable ad engagement.
 */
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

const bodySchema = z.object({
  station_id: z.string().trim().regex(/^[A-Za-z0-9_-]{3,40}$/),
  events: z.array(z.object({
    campaign_id: z.string().uuid(),
    creative_id: z.string().uuid().optional(),
    kind: z.enum(["playback", "impression", "click"]),
    dedupe_key: z.string().trim().min(8).max(120).optional(),
    at: z.string().datetime().optional(),
  })).min(1).max(100),
});

export async function POST(req: Request) {
  const secret = process.env.KIOSK_INGEST_SECRET;
  if (!secret) return NextResponse.json({ error: "Device ingest not configured" }, { status: 503 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEq(bearer, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 422 });
  const { station_id, events } = parsed.data;

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const { data: kiosk } = await db.from("kiosks")
    .select("id,venue_id,venues(id,city,state,venue_type)")
    .eq("station_id", station_id).maybeSingle();
  if (!kiosk) return NextResponse.json({ error: "Unknown station" }, { status: 404 });
  const venue = (kiosk as { venues?: { id: string; city: string | null; venue_type: string | null } | { id: string; city: string | null; venue_type: string | null }[] | null }).venues;
  const venueRow = Array.isArray(venue) ? venue[0] ?? null : venue ?? null;

  // Resolve each referenced campaign once.
  const campaignIds = [...new Set(events.map((e) => e.campaign_id))];
  const { data: campaigns, error } = await db.from("advertising_campaigns")
    .select("id,status,payment_status,targeting,schedule,starts_at,ends_at")
    .in("id", campaignIds);
  if (error) { reportError(error, { route: "kiosks/playback" }); return NextResponse.json({ error: "Ingest failed" }, { status: 500 }); }

  const now = new Date();
  const eligible = new Map<string, boolean>();
  for (const c of (campaigns ?? []) as Record<string, unknown>[]) {
    const cid = c.id as string;
    const ok = isCampaignDeliverable(c as Parameters<typeof isCampaignDeliverable>[0], now)
      && await campaignTargetsKiosk(db, c as Parameters<typeof campaignTargetsKiosk>[1], { id: kiosk.id, venue_id: kiosk.venue_id }, venueRow);
    eligible.set(cid, ok);
  }

  let accepted = 0, duplicates = 0, rejected = 0;
  for (const e of events) {
    if (!eligible.get(e.campaign_id)) { rejected++; continue; }
    const at = e.at ?? now.toISOString();
    const dedupe = e.dedupe_key ?? `${kiosk.id}:${e.campaign_id}:${e.kind}:${at.slice(0, 16)}`;
    const { error: insErr } = await db.from("ad_events").insert({
      campaign_id: e.campaign_id, creative_id: e.creative_id ?? null, kiosk_id: kiosk.id,
      kind: e.kind, dedupe_key: dedupe, occurred_at: at,
    });
    if (insErr?.code === "23505") duplicates++;
    else if (insErr) { reportError(insErr, { route: "kiosks/playback" }); rejected++; }
    else accepted++;
  }
  return NextResponse.json({ ok: true, accepted, duplicates, rejected });
}
