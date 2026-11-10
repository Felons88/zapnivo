import { NextResponse } from "next/server";
import { z } from "zod";
import { reportError } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { createCampaign, priceCampaign, requireAdvertiserRole, type Targeting, type Schedule } from "@/lib/ads/service";

const idList = (max: number) => z.array(z.string().uuid()).max(max).optional();
const targetingSchema = z.object({
  station_ids: idList(500),
  venue_ids: idList(500),
  cities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  venue_types: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  placement: z.enum(["kiosk_screen", "website", "email", "event"]).optional(),
}).strict();
const scheduleSchema = z.object({
  starts_at: z.string().datetime({ offset: true }).optional(),
  ends_at: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().trim().max(60).optional(),
  dayparts: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
}).strict().refine((s) => !s.starts_at || !s.ends_at || Date.parse(s.ends_at) > Date.parse(s.starts_at), { message: "End must be after start." });

export const campaignSchema = z.object({
  org_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  objective: z.enum(["brand_awareness", "venue_promotion", "local_business", "event_promotion", "website_traffic", "qr_engagement", "product_promotion"]),
  pricing_model: z.enum(["fixed", "cpm", "cpc", "sponsored_credits"]),
  placement: z.enum(["kiosk_screen", "website", "email", "event"]).optional(),
  budget_cents: z.number().int().min(0).max(100_000_000).optional(),
  targeting: targetingSchema.optional(),
  schedule: scheduleSchema.optional(),
}).strict();

/** Create a draft campaign. org_id is verified against advertiser_members server-side. */
export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = campaignSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;

  const ctx = await requireAdvertiserRole("member", d.org_id ?? null);
  if (!ctx) return NextResponse.json({ error: "You don't have access to that organization." }, { status: 403 });
  const rl = rateLimit(`ads-campaign:${ctx.user.id}`, 20, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  // Placement lives inside targeting jsonb (no dedicated column); pricing_model is a real column.
  const targeting: Targeting = { ...(d.targeting ?? {}) };
  if (d.placement) targeting.placement = d.placement;
  const schedule: Schedule = d.schedule ?? {};

  // Fixed-price campaigns get a server-computed budget when the client didn't send one.
  let budget = d.budget_cents ?? null;
  const days = schedule.starts_at && schedule.ends_at
    ? Math.max(1, Math.ceil((Date.parse(schedule.ends_at) - Date.parse(schedule.starts_at)) / 86_400_000))
    : undefined;
  if (budget == null && d.placement && d.pricing_model !== "sponsored_credits") {
    const price = await priceCampaign(ctx.db, { placement: d.placement, model: d.pricing_model, stations: targeting.station_ids?.length ?? 0, days });
    if (price?.totalCents != null) budget = price.totalCents;
  }

  try {
    const created = await createCampaign(ctx.db, ctx.org, {
      name: d.name, objective: d.objective, pricing_model: d.pricing_model,
      targeting, schedule, budget_cents: budget,
    });
    if ("error" in created) return NextResponse.json({ error: created.error }, { status: 500 });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (e) {
    reportError(e, { route: "/api/advertiser/campaigns", attrs: { op: "create" } });
    return NextResponse.json({ error: "Couldn't create the campaign." }, { status: 500 });
  }
}
