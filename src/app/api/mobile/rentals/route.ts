import { NextResponse } from "next/server";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { advanceSimDispenses, dispenseStatusFor } from "@/lib/kiosk/dispatch";
import { reconcileStuckPayments } from "@/lib/payments/reconcile";
import { recordLog } from "@/lib/observability";

export const dynamic = "force-dynamic";

type Row = {
  id: string; reference: string; state: string; created_at: string; dispensed_at: string | null;
  returned_at: string | null; non_return_deadline: string | null; bank_count: number; promo_code: string | null;
  kiosk_id: string | null;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: { amount_captured_cents: number | null; amount_authorized_cents: number | null; tax_cents: number | null; discount_cents: number | null; state: string; receipt_email: string | null }[];
};

const DISPATCH_STATES = new Set(["payment_authorized", "dispense_pending", "active"]);

/** Read-only rental timeline; physical kiosk events remain the source of truth for dispensing and return. */
export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  // Advance due test-kiosk sim stages through the real ingest pipeline — the
  // customer's own poll drives the virtual-kiosk timeline (cron covers the
  // idle case). A sim failure must never break the rental read.
  await advanceSimDispenses(c.db).catch((e) =>
    recordLog("warning", "sim_dispense_advance_failed", { service: "mobile", route: "/api/mobile/rentals", attrs: { reason: e instanceof Error ? e.message : "unknown" } }));
  // Self-heal paid-but-stranded rentals: the same poll that advances the kiosk
  // sim asks Stripe directly when a webhook event didn't arrive.
  await reconcileStuckPayments(c.db, { customerId: c.user.id }).catch((e) =>
    recordLog("warning", "payment_reconcile_failed", { service: "mobile", route: "/api/mobile/rentals", attrs: { reason: e instanceof Error ? e.message : "unknown" } }));
  const { data, error } = await c.db.from("rentals")
    .select("id,reference,state,created_at,dispensed_at,returned_at,non_return_deadline,bank_count,promo_code,kiosk_id,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(amount_captured_cents,amount_authorized_cents,tax_cents,discount_cents,state,receipt_email)")
    .or(`customer_id.eq.${c.user.id},renter_profile.eq.${c.user.id}`).order("created_at", { ascending: false }).limit(50);
  if (error) {
    recordLog("error", "mobile_rentals_query_failed", { service: "mobile", route: "/api/mobile/rentals", attrs: { code: error.code, message: error.message.slice(0, 200) } });
    return NextResponse.json({ error: "Rental history unavailable." }, { status: 503 });
  }
  const rows = (data ?? []) as unknown as Row[];
  const rentals = await Promise.all(rows.map(async (r) => {
    const paid = r.payments.find((p) => p.state === "captured");
    const pay = paid ?? r.payments[0];
    const dispense = DISPATCH_STATES.has(r.state)
      ? await dispenseStatusFor(c.db, { id: r.id, state: r.state, kiosk_id: r.kiosk_id }).catch(() => null)
      : null;
    return {
      reference: r.reference, state: r.state, created_at: r.created_at,
      dispensed_at: r.dispensed_at, returned_at: r.returned_at,
      return_deadline: r.non_return_deadline, bank_count: r.bank_count, promo_code: r.promo_code,
      station_id: r.kiosks?.station_id ?? null, venue: r.kiosks?.venues?.name ?? null,
      city: r.kiosks?.venues?.city ?? null,
      amount_captured_cents: paid?.amount_captured_cents ?? null,
      amount_authorized_cents: pay?.amount_authorized_cents ?? null,
      tax_cents: paid?.tax_cents ?? null, discount_cents: paid?.discount_cents ?? null,
      payment_state: pay?.state ?? null, receipt_email: pay?.receipt_email ?? null,
      ...(dispense ? { dispense } : {}),
    };
  }));
  return NextResponse.json({ rentals }, { headers: { "Cache-Control": "no-store" } });
}
