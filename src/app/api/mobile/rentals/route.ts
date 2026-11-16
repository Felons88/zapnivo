import { NextResponse } from "next/server";
import { getBearerUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type Row = {
  id: string; reference: string; state: string; created_at: string; dispensed_at: string | null;
  returned_at: string | null; non_return_deadline: string | null; bank_count: number;
  kiosks: { station_id: string; venues: { name: string; city: string } | null } | null;
  payments: { amount_captured_cents: number | null; state: string }[];
};

/** Read-only rental timeline; physical kiosk events remain the source of truth for dispensing and return. */
export async function GET(req: Request) {
  const user = await getBearerUser(req);
  if (!user || user.role !== "customer") return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Rental history unavailable." }, { status: 503 });
  const { data, error } = await db.from("rentals")
    .select("id,reference,state,created_at,dispensed_at,returned_at,non_return_deadline,bank_count,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(amount_captured_cents,state)")
    .eq("customer_id", user.id).order("created_at", { ascending: false }).limit(30);
  if (error) return NextResponse.json({ error: "Rental history unavailable." }, { status: 503 });
  const rentals = ((data ?? []) as unknown as Row[]).map((r) => ({
    reference: r.reference, state: r.state, created_at: r.created_at,
    dispensed_at: r.dispensed_at, returned_at: r.returned_at,
    return_deadline: r.non_return_deadline, bank_count: r.bank_count,
    station_id: r.kiosks?.station_id ?? null, venue: r.kiosks?.venues?.name ?? null,
    city: r.kiosks?.venues?.city ?? null,
    amount_captured_cents: r.payments.find((p) => p.state === "captured")?.amount_captured_cents ?? null,
    receipt_url: `/api/receipts/${encodeURIComponent(r.reference)}`,
  }));
  return NextResponse.json({ rentals }, { headers: { "Cache-Control": "no-store" } });
}
