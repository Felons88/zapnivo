import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { computeSummary, fetchFinanceData, parsePeriodDays, periodWindow } from "@/lib/admin-finance";
import { serviceClient } from "@/lib/supabase";

/** Platform finance summary — admin only. All amounts are integer cents; see src/lib/admin-finance.ts. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const days = parsePeriodDays(new URL(req.url).searchParams.get("days"));
  const window = periodWindow(days);
  const data = await fetchFinanceData(db, window);
  return NextResponse.json({ ...computeSummary(data, window), notes: {
    revenueBasis: "captured payments only — authorizations and released holds are never counted",
    stripeFees: data.actualStripeFeesCents != null ? "actual (billing_ledger)" : "estimate: 2.9% + $0.30 per captured payment",
    smsCost: data.smsCostPerMessageCents != null ? `tracked at ${data.smsCostPerMessageCents}¢/message (system_config.${"sms_outbound_cost_cents"})` : "not tracked — set system_config.sms_outbound_cost_cents to enable",
    nonReturnClassification: "captured payments on rentals currently in a non-return state (charged_off / non_return_fee_*)",
  } }, { headers: { "Cache-Control": "no-store" } });
}
