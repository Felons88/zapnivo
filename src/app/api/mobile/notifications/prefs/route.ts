import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const COLUMNS = ["offers", "product_updates", "rental_reminders", "support_updates", "rewards"] as const;
const hour = z.number().int().min(0).max(23).nullable();

const putSchema = z.object({
  offers: z.boolean().optional(),
  product_updates: z.boolean().optional(),
  rental_reminders: z.boolean().optional(),
  support_updates: z.boolean().optional(),
  rewards: z.boolean().optional(),
  quiet_start: hour.optional(),
  quiet_end: hour.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

/**
 * GET    — the customer's optional-category preferences (+ quiet hours).
 *          Essential categories (security/payment/account) have NO toggles —
 *          they can't be opted out of by design.
 * PUT    — upsert the row; only the keys present are changed.
 */
export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const { data } = await c.db.from("customer_notification_prefs")
    .select("offers,product_updates,rental_reminders,support_updates,rewards,quiet_start,quiet_end,timezone")
    .eq("profile_id", c.user.id).maybeSingle();
  const p = data as Record<string, unknown> | null;
  return NextResponse.json({
    offers: p?.offers ?? true,
    product_updates: p?.product_updates ?? true,
    rental_reminders: p?.rental_reminders ?? true,
    support_updates: p?.support_updates ?? true,
    rewards: p?.rewards ?? true,
    quiet_start: p?.quiet_start ?? null,
    quiet_end: p?.quiet_end ?? null,
    timezone: p?.timezone ?? "America/Chicago",
  });
}

export async function PUT(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-notif:${c.user.id}`, 30, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const p = putSchema.safeParse(await req.json().catch(() => null));
  if (!p.success || !Object.keys(p.data).length) return NextResponse.json({ error: "Invalid preferences." }, { status: 422 });
  const { error } = await c.db.from("customer_notification_prefs")
    .upsert({ profile_id: c.user.id, ...p.data, updated_at: new Date().toISOString() }, { onConflict: "profile_id" });
  if (error) return NextResponse.json({ error: "Could not save preferences." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
