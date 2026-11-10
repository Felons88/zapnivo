import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { reportError } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import {
  extForMime, getCampaign, validateMediaCreative, validateTextCreative,
  type CampaignRow,
} from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";

const textSchema = z.object({
  kind: z.literal("text"),
  campaign_id: z.string().uuid(),
  headline: z.string().max(2000).optional(),
  body: z.string().max(5000).optional(),
  destination_url: z.string().max(1000).optional(),
});
const mediaSchema = z.object({
  kind: z.enum(["image", "video"]),
  campaign_id: z.string().uuid(),
  file_name: z.string().trim().min(1).max(200),
  data_base64: z.string().min(1).max(90_000_000), // ~67MB decoded ceiling; real caps enforced below
});
const postSchema = z.discriminatedUnion("kind", [textSchema, mediaSchema]);

const BUCKET = "ad-creatives";
const CREATIVE_COLS = "id,campaign_id,kind,mime,bytes,width,height,duration_ms,headline,body,destination_url,version,status,review_note,created_at,updated_at";

type MemberCheck = { ok: true; campaign: CampaignRow; orgId: string } | { ok: false; res: NextResponse };

/** Loads the campaign and verifies the session user is a member of its org. */
async function authorizeCampaign(campaignId: string): Promise<MemberCheck> {
  const db = serviceClient();
  if (!db) return { ok: false, res: NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 }) };
  const user = await getSessionUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Sign in first." }, { status: 401 }) };
  const campaign = await getCampaign(db, campaignId);
  if (!campaign || !campaign.advertiser_org_id) return { ok: false, res: NextResponse.json({ error: "Campaign not found." }, { status: 404 }) };
  const { data: mem } = await db.from("advertiser_members").select("role").eq("org_id", campaign.advertiser_org_id).eq("profile_id", user.id).maybeSingle();
  if (!mem) return { ok: false, res: NextResponse.json({ error: "You don't have access to this campaign." }, { status: 403 }) };
  return { ok: true, campaign, orgId: campaign.advertiser_org_id };
}

/** POST /api/advertiser/creatives — JSON body; media arrives base64-encoded. */
export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;

  const auth = await authorizeCampaign(d.campaign_id);
  if (!auth.ok) return auth.res;
  const { campaign, orgId } = auth;
  const user = await getSessionUser();
  const rl = rateLimit(`ads-creative:${user?.id ?? "anon"}`, 30, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many uploads. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const creativeStatus = campaign.status === "pending_approval" ? "submitted" : "draft";

  try {
    if (d.kind === "text") {
      const v = validateTextCreative(d);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 422 });
      const { error } = await db.from("ad_creatives").insert({
        campaign_id: campaign.id, kind: "text",
        headline: v.headline || null, body: v.body || null, destination_url: v.destination_url,
        status: creativeStatus, created_by: user?.id ?? null,
      });
      if (error) throw error;
      return NextResponse.json({ ok: true, kind: "text", status: creativeStatus });
    }

    // Media: decode, size-cap, then magic-byte sniff — declared mime is never trusted.
    let buf: Buffer;
    try { buf = Buffer.from(d.data_base64, "base64"); } catch { return NextResponse.json({ error: "Invalid file encoding." }, { status: 422 }); }
    const media = validateMediaCreative(d.kind, buf);
    if (!media.ok) return NextResponse.json({ error: media.error }, { status: 422 });

    const path = `${orgId}/${campaign.id}/${randomUUID()}.${extForMime(media.mime)}`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, buf, { contentType: media.mime, upsert: false });
    if (upErr) {
      reportError(upErr, { route: "/api/advertiser/creatives", attrs: { op: "storage_upload" } });
      return NextResponse.json({ error: "Couldn't store the file. Try again." }, { status: 500 });
    }
    const { error } = await db.from("ad_creatives").insert({
      campaign_id: campaign.id, kind: d.kind, storage_path: path, mime: media.mime, bytes: media.bytes,
      status: creativeStatus, created_by: user?.id ?? null,
    });
    if (error) {
      reportError(error, { route: "/api/advertiser/creatives", attrs: { op: "insert" } });
      return NextResponse.json({ error: "File uploaded but the creative couldn't be saved." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, kind: d.kind, status: creativeStatus });
  } catch (e) {
    reportError(e, { route: "/api/advertiser/creatives", attrs: { op: "create" } });
    return NextResponse.json({ error: "Couldn't save the creative." }, { status: 500 });
  }
}

/** GET /api/advertiser/creatives?campaign_id=… — lists creatives for a campaign the user can access. */
export async function GET(req: Request) {
  const campaignId = new URL(req.url).searchParams.get("campaign_id");
  if (!campaignId || !z.string().uuid().safeParse(campaignId).success) {
    return NextResponse.json({ error: "campaign_id is required." }, { status: 400 });
  }
  const auth = await authorizeCampaign(campaignId);
  if (!auth.ok) return auth.res;
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { data, error } = await db.from("ad_creatives").select(CREATIVE_COLS).eq("campaign_id", campaignId).order("created_at", { ascending: false }).limit(100);
  if (error) {
    reportError(error, { route: "/api/advertiser/creatives", attrs: { op: "list" } });
    return NextResponse.json({ error: "Couldn't load creatives." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, creatives: data ?? [] });
}
