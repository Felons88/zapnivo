import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { GIFT_PUBLIC_SELECT, type GiftRow, type GiftStatus } from "@/lib/gifts";
import { fail } from "@/lib/helpdesk/http";
import { serviceClient } from "@/lib/supabase";

const STATUSES: GiftStatus[] = ["pending_payment", "paid", "redeemed", "expired", "refunded"];

/** Staff gift listing. ?status= filters; code_hash is never selected. */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return fail(403, "Staff only.");
  const db = serviceClient();
  if (!db) return fail(503, "Backend not configured", { code: "backend_unconfigured" });

  const status = new URL(req.url).searchParams.get("status") ?? "";
  let q = db.from("gift_credits").select(GIFT_PUBLIC_SELECT).order("created_at", { ascending: false }).limit(300);
  if (status && (STATUSES as string[]).includes(status)) q = q.eq("status", status as GiftStatus);
  const { data, error } = await q;
  if (error) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });
  return NextResponse.json({ gifts: (data ?? []) as GiftRow[] }, { headers: { "Cache-Control": "no-store" } });
}
