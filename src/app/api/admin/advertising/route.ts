import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { reportError } from "@/lib/observability";

const uuid = z.string().uuid();
const cents = z.coerce.number().int().min(0).max(100_000_000);

const inquiry = z.object({ action: z.literal("inquiry_state"), id: uuid, state: z.enum(["new", "reviewing", "closed"]) });
const campaignReview = z.object({
  action: z.literal("campaign_review"), id: uuid,
  decision: z.enum(["approve", "reject", "taken_down"]),
  note: z.string().trim().max(500).optional(),
});
const campaignStatus = z.object({
  action: z.literal("campaign_status"), id: uuid,
  status: z.enum(["scheduled", "live", "paused"]),
});
const rateCard = z.object({
  action: z.literal("rate_card_create"),
  placement: z.enum(["kiosk_screen", "website", "email", "event"]),
  pricing_model: z.enum(["fixed", "cpm", "cpc"]),
  unit_price_cents: cents,
  min_spend_cents: cents.default(0),
  duration_days: z.coerce.number().int().min(1).max(365).default(7),
  note: z.string().trim().max(300).optional(),
});
const sponsorReview = z.object({
  action: z.literal("sponsor_review"), id: uuid,
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});
const planCreate = z.object({
  action: z.literal("plan_create"),
  id: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  price_cents: cents,
  interval: z.enum(["one_time", "month", "year"]),
  benefit_rental_minutes: z.coerce.number().int().min(0).max(100_000).optional(),
  benefit_rentals: z.coerce.number().int().min(0).max(10_000).optional(),
  active: z.union([z.literal("on"), z.literal("off")]).optional(),
});
const planToggle = z.object({ action: z.literal("plan_toggle"), id: z.string().trim().max(80), active: z.union([z.literal("on"), z.literal("off")]) });

const schema = z.discriminatedUnion("action", [inquiry, campaignReview, campaignStatus, rateCard, sponsorReview, planCreate, planToggle]);

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const form = await req.formData();
  const entries = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  const parsed = schema.safeParse(entries);
  const url = new URL("/admin/advertising", req.url);
  if (!parsed.success) { url.searchParams.set("result", "invalid"); return NextResponse.redirect(url, 303); }

  try {
    const d = parsed.data;
    switch (d.action) {
      case "inquiry_state": {
        const { data, error } = await db.from("advertising_inquiries").update({ state: d.state }).eq("id", d.id).select("id").maybeSingle();
        url.searchParams.set("result", error || !data ? "error" : "saved");
        break;
      }
      case "campaign_review": {
        const { data: camp } = await db.from("advertising_campaigns").select("id,status").eq("id", d.id).maybeSingle();
        if (!camp) { url.searchParams.set("result", "error"); break; }
        if (d.decision === "approve") {
          // Approve the campaign AND all its submitted creatives atomically-ish.
          await db.from("ad_creatives").update({ status: "approved", reviewed_by: user!.id, reviewed_at: new Date().toISOString(), review_note: d.note ?? null })
            .eq("campaign_id", d.id).eq("status", "submitted");
          const { data, error } = await db.from("advertising_campaigns")
            .update({ status: "approved", approved_by: user!.id, approved_at: new Date().toISOString(), review_note: d.note ?? null })
            .eq("id", d.id).in("status", ["pending_approval", "draft"]).select("id").maybeSingle();
          url.searchParams.set("result", error || !data ? "error" : "saved");
        } else {
          const status = d.decision === "reject" ? "draft" : "taken_down";
          const { data, error } = await db.from("advertising_campaigns")
            .update({ status, review_note: d.note ?? null })
            .eq("id", d.id).select("id").maybeSingle();
          url.searchParams.set("result", error || !data ? "error" : "saved");
        }
        break;
      }
      case "campaign_status": {
        const { data, error } = await db.from("advertising_campaigns")
          .update({ status: d.status, ...(d.status === "live" ? { activated_at: new Date().toISOString() } : {}) })
          .eq("id", d.id).in("status", ["approved", "scheduled", "live", "paused"]).select("id").maybeSingle();
        url.searchParams.set("result", error || !data ? "error" : "saved");
        break;
      }
      case "rate_card_create": {
        const { error } = await db.from("ad_rate_cards").insert({
          placement: d.placement, pricing_model: d.pricing_model, unit_price_cents: d.unit_price_cents,
          min_spend_cents: d.min_spend_cents, duration_days: d.duration_days, note: d.note ?? null, created_by: user!.id,
        });
        url.searchParams.set("result", error ? "error" : "saved");
        break;
      }
      case "sponsor_review": {
        const status = d.decision === "approve" ? "active" : "rejected";
        const { data, error } = await db.from("sponsor_campaigns")
          .update({ status, review_note: d.note ?? null, ...(d.decision === "approve" ? { approved_by: user!.id } : {}) })
          .eq("id", d.id).eq("status", "pending").select("id").maybeSingle();
        url.searchParams.set("result", error || !data ? "error" : "saved");
        break;
      }
      case "plan_create": {
        const benefit: Record<string, number> = {};
        if (d.benefit_rental_minutes) benefit.rental_minutes = d.benefit_rental_minutes;
        if (d.benefit_rentals) benefit.rentals = d.benefit_rentals;
        if (!Object.keys(benefit).length) { url.searchParams.set("result", "invalid"); break; }
        const { error } = await db.from("membership_plans").insert({
          id: d.id, name: d.name, description: d.description ?? null, price_cents: d.price_cents,
          interval: d.interval, benefit, active: d.active === "on",
        });
        url.searchParams.set("result", error ? "error" : "saved");
        break;
      }
      case "plan_toggle": {
        const { data, error } = await db.from("membership_plans").update({ active: d.active === "on" }).eq("id", d.id).select("id").maybeSingle();
        url.searchParams.set("result", error || !data ? "error" : "saved");
        break;
      }
    }
  } catch (e) {
    reportError(e, { route: "admin/advertising" });
    url.searchParams.set("result", "error");
  }
  return NextResponse.redirect(url, 303);
}
