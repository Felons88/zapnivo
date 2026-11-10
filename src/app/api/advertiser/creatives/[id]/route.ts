import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { reportError } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { getCampaign, validateTextCreative, type CampaignRow } from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";

const patchSchema = z.object({
  action: z.enum(["update", "archive"]).default("update"),
  headline: z.string().max(2000).optional(),
  body: z.string().max(5000).optional(),
  destination_url: z.string().max(1000).optional(),
}).strict();

type CreativeRow = {
  id: string;
  campaign_id: string;
  kind: "image" | "video" | "text";
  headline: string | null;
  body: string | null;
  destination_url: string | null;
  status: "draft" | "submitted" | "approved" | "rejected" | "archived";
};

/**
 * PATCH /api/advertiser/creatives/[id]
 * Advertisers may edit draft/rejected text creatives and archive any non-archived
 * creative in a campaign they belong to. Approved creatives are locked pending review.
 */
export async function PATCH(req: Request, ctxParams: { params: Promise<{ id: string }> }) {
  const { id } = await ctxParams.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { data: creative, error: cErr } = await db
    .from("ad_creatives")
    .select("id,campaign_id,kind,headline,body,destination_url,status")
    .eq("id", id)
    .maybeSingle();
  if (cErr || !creative) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const row = creative as unknown as CreativeRow;

  const campaign = (await getCampaign(db, row.campaign_id)) as CampaignRow | null;
  if (!campaign?.advertiser_org_id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { data: mem } = await db.from("advertiser_members").select("role").eq("org_id", campaign.advertiser_org_id).eq("profile_id", user.id).maybeSingle();
  if (!mem) return NextResponse.json({ error: "You don't have access to this creative." }, { status: 403 });

  const rl = rateLimit(`ads-creative:${user.id}`, 30, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });

  try {
    if (parsed.data.action === "archive") {
      if (row.status === "archived") return NextResponse.json({ ok: true });
      const { error } = await db.from("ad_creatives").update({ status: "archived" }).eq("id", row.id);
      if (error) throw error;
      return NextResponse.json({ ok: true, status: "archived" });
    }

    if (row.kind !== "text") {
      return NextResponse.json({ error: "Media creatives can't be edited — upload a new version instead." }, { status: 422 });
    }
    if (row.status !== "draft" && row.status !== "rejected") {
      return NextResponse.json({ error: `A ${row.status} creative can't be edited.` }, { status: 409 });
    }
    const v = validateTextCreative({
      headline: parsed.data.headline ?? row.headline ?? undefined,
      body: parsed.data.body ?? row.body ?? undefined,
      destination_url: parsed.data.destination_url ?? row.destination_url ?? undefined,
    });
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 422 });
    const { error } = await db.from("ad_creatives").update({
      headline: v.headline || null, body: v.body || null, destination_url: v.destination_url, updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { route: "/api/advertiser/creatives/[id]", attrs: { op: parsed.data.action } });
    return NextResponse.json({ error: "Couldn't save the creative." }, { status: 500 });
  }
}
