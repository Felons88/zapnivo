import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { reportError } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { getCampaign, submitCampaign, type Targeting, type Schedule } from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";
import { campaignSchema } from "../route";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  objective: z.enum(["brand_awareness", "venue_promotion", "local_business", "event_promotion", "website_traffic", "qr_engagement", "product_promotion"]).optional(),
  pricing_model: z.enum(["fixed", "cpm", "cpc", "sponsored_credits"]).optional(),
  placement: z.enum(["kiosk_screen", "website", "email", "event"]).optional(),
  budget_cents: z.number().int().min(0).max(100_000_000).optional(),
  targeting: campaignSchema.shape.targeting,
  schedule: campaignSchema.shape.schedule,
}).strict();

const patchSchema = z.object({
  action: z.enum(["update", "submit"]).default("update"),
  campaign: updateSchema.optional(),
}).strict();

/**
 * PATCH /api/advertiser/campaigns/[id]
 * action=update → edit draft fields; action=submit → draft → pending_approval.
 * Membership is derived from the campaign's advertiser_org_id — client ids are never trusted.
 */
export async function PATCH(req: Request, ctxParams: { params: Promise<{ id: string }> }) {
  const { id } = await ctxParams.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });
  const campaign = await getCampaign(db, id);
  if (!campaign || !campaign.advertiser_org_id) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Authorize against the campaign's org — org id comes from the DB row, not the client.
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data: mem } = await db
    .from("advertiser_members")
    .select("role")
    .eq("org_id", campaign.advertiser_org_id)
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!mem || !["owner", "admin", "member"].includes((mem as { role: string }).role)) {
    return NextResponse.json({ error: "You don't have access to this campaign." }, { status: 403 });
  }
  const rl = rateLimit(`ads-campaign:${user.id}`, 30, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });

  try {
    if (parsed.data.action === "submit") {
      const result = await submitCampaign(db, campaign);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
      return NextResponse.json({ ok: true, status: "pending_approval" });
    }

    if (campaign.status !== "draft") {
      return NextResponse.json({ error: "Only draft campaigns can be edited." }, { status: 409 });
    }
    const c = parsed.data.campaign;
    if (!c) return NextResponse.json({ error: "Nothing to update." }, { status: 422 });

    const update: Record<string, unknown> = {};
    if (c.name !== undefined) update.name = c.name;
    if (c.objective !== undefined) update.objective = c.objective;
    if (c.pricing_model !== undefined) update.pricing_model = c.pricing_model;
    if (c.budget_cents !== undefined) update.budget_cents = c.budget_cents;
    if (c.targeting !== undefined || c.placement !== undefined) {
      const targeting: Targeting = { ...(campaign.targeting ?? {}), ...(c.targeting ?? {}) };
      if (c.placement !== undefined) targeting.placement = c.placement;
      update.targeting = targeting;
    }
    if (c.schedule !== undefined) {
      const schedule: Schedule = { ...(campaign.schedule ?? {}), ...c.schedule };
      update.schedule = schedule;
      update.starts_at = schedule.starts_at ?? null;
      update.ends_at = schedule.ends_at ?? null;
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: "Nothing to update." }, { status: 422 });

    const { error } = await db.from("advertising_campaigns").update(update).eq("id", campaign.id).eq("status", "draft");
    if (error) {
      reportError(error, { route: "/api/advertiser/campaigns/[id]", attrs: { op: "update" } });
      return NextResponse.json({ error: "Couldn't save changes." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { route: "/api/advertiser/campaigns/[id]", attrs: { op: parsed.data.action } });
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
