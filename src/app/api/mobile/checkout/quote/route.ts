import { NextResponse } from "next/server";
import { z } from "zod";
import { applyPromo, holdCents, PRICING_SELECT, pricingFromRow, type PricingRow } from "@/lib/billing";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { lookupPromo, promoUsable, PROMO_CODE_RE } from "@/lib/promos";
import { rateLimit } from "@/lib/rate-limit";
import { stationMaintenanceBlock } from "@/lib/kiosk/availability";
import { newTraceId, recordLog } from "@/lib/observability";

export const dynamic = "force-dynamic";

const schema = z.object({
  station_id: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
  bank_count: z.coerce.number().int().min(1).max(3).default(1),
  promo_code: z.string().trim().regex(PROMO_CODE_RE).optional().or(z.literal("").transform(() => undefined)),
});

const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/**
 * Read-only checkout quote for the native app's review step. Re-runs the same
 * station gates as /api/rentals/checkout (availability, maintenance, inventory,
 * pricing) and VALIDATES a promo without reserving a redemption — the actual
 * redemption happens atomically inside checkout itself.
 *
 * Amounts returned are authoritative server-side cents: the client renders them
 * verbatim and never computes its own prices. `first_hour_estimate_cents` is an
 * estimate only — the final charge is computed from actual usage at return.
 */
export async function POST(req: Request) {
  const traceId = newTraceId();
  const log = (level: "info" | "warning" | "error", message: string, attrs?: Record<string, unknown>) =>
    recordLog(level, message, { service: "mobile", route: "/api/mobile/checkout/quote", traceId, attrs });

  const rl = rateLimit(`quote:${clientIp(req)}`, 30, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Please try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const { db } = c;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Please check the details you entered.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const { station_id, bank_count, promo_code } = parsed.data;

  const { data: kiosk } = await db.from("kiosks").select("id,state,test_mode,venues(published)").eq("station_id", station_id).maybeSingle();
  const kioskRow = kiosk as unknown as { id: string; state: string; test_mode?: boolean | null; venues: { published: boolean } | null } | null;
  const testMode = kioskRow?.test_mode === true;
  if (!kiosk || !kioskRow || (!testMode && (kioskRow.state !== "online" || !kioskRow.venues?.published))) {
    log("warning", "quote_station_unavailable", { stationId: station_id });
    return NextResponse.json({ error: "This station isn't available right now.", code: "station_unavailable" }, { status: 409 });
  }
  if (await stationMaintenanceBlock(db, station_id)) {
    return NextResponse.json({ error: "This station is under maintenance right now.", code: "station_in_maintenance" }, { status: 409 });
  }

  const priceQuery = db.from("pricing_versions").select(PRICING_SELECT);
  const { data: pr } = await (testMode ? priceQuery : priceQuery.eq("approved", true))
    .order("effective_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (!pr) return NextResponse.json({ error: "Pricing has not been approved yet, so rentals can't be started.", code: "pricing_not_approved" }, { status: 503 });
  const pricing = pricingFromRow(pr as PricingRow);

  const { count } = await db.from("kiosk_slots").select("slot_number", { count: "exact", head: true }).eq("kiosk_id", kioskRow.id).eq("state", "ready");
  const readyBanks = testMode ? Math.max(count ?? 0, bank_count) : (count ?? 0);
  if (readyBanks < 1) return NextResponse.json({ error: "No chargers are ready at this station right now.", code: "station_unavailable" }, { status: 409 });

  // Promo is previewed against the estimated first-hour charge; the real discount
  // is recomputed at settlement from actual usage.
  const firstHourEstimate = pricing.firstHourCents * bank_count;
  let promo: Record<string, unknown> | null = null;
  if (promo_code) {
    const p = await lookupPromo(db, promo_code);
    if (!p || !promoUsable(p)) {
      promo = { code: promo_code, valid: false };
    } else {
      const { discountCents } = applyPromo(firstHourEstimate, p);
      promo = {
        code: p.code,
        valid: true,
        percent_off: p.percent_off === null ? null : Number(p.percent_off),
        amount_off_cents: p.amount_off_cents,
        discount_preview_cents: discountCents,
      };
    }
  }

  log("info", "quote_issued", { stationId: station_id, bankCount: bank_count, promo: promo?.valid === true });
  return NextResponse.json({
    quote: {
      station_id,
      bank_count,
      ready_banks: readyBanks,
      hold_cents: holdCents(pricing, bank_count),
      first_hour_estimate_cents: firstHourEstimate,
      additional_hour_cents: pricing.additionalHourCents,
      non_return_max_cents: pricing.nonReturnMaxCents,
      non_return_after_hours: pricing.nonReturnAfterHours,
      promo,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
