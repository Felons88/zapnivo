import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { isStaff, getSessionUser } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

type PurchaseRow = {
  id: string; group_id: string; organizer_id: string;
  amount_cents: number; status: string;
};

/**
 * POST /api/admin/groups/funding/[id]/refund — staff-only.
 * Marks a paid group_credit_purchases row 'refunded' and decrements the group's
 * credit pool via the atomic adjust_group_credit RPC (which also writes the
 * entitlement_events audit row). No Stripe refund is issued here — handle the
 * money movement in the Stripe dashboard / payments admin, then record it.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;

  const { data: p } = await db.from("group_credit_purchases")
    .select("id,group_id,organizer_id,amount_cents,status").eq("id", id).maybeSingle();
  const purchase = p as PurchaseRow | null;
  if (!purchase) return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
  if (purchase.status !== "paid") {
    return NextResponse.json({ error: `Purchase is ${purchase.status}, not paid.`, code: "not_paid" }, { status: 409 });
  }

  // Guarded flip paid → refunded first so a double-submit can't decrement twice.
  const { data: flipped, error: flipErr } = await db.from("group_credit_purchases")
    .update({ status: "refunded" }).eq("id", purchase.id).eq("status", "paid")
    .select("id").maybeSingle();
  if (flipErr) {
    recordLog("warning", "group_funding_refund_flip_failed", { service: "groups", route: "api/admin/groups/funding/[id]/refund", attrs: { err: flipErr.message.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't update the purchase." }, { status: 503 });
  }
  if (!flipped) return NextResponse.json({ error: "Purchase was already refunded.", code: "already_refunded" }, { status: 409 });

  const { error: rpcErr } = await db.rpc("adjust_group_credit", {
    p_group: purchase.group_id,
    p_delta: -purchase.amount_cents,
    p_actor: `staff:${user!.id}`,
    p_note: "Group funding refund",
  });
  if (rpcErr) {
    // Pool decrement failed after the status flip — restore 'paid' so staff can retry cleanly.
    await db.from("group_credit_purchases").update({ status: "paid" }).eq("id", purchase.id).eq("status", "refunded");
    recordLog("error", "group_funding_refund_rpc_failed", { service: "groups", route: "api/admin/groups/funding/[id]/refund", attrs: { purchase: purchase.id.slice(0, 8), err: String(rpcErr.message ?? rpcErr).slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't decrement the credit pool." }, { status: 503 });
  }

  recordLog("info", "group_funding_refunded", { service: "groups", route: "api/admin/groups/funding/[id]/refund", attrs: { purchase: purchase.id.slice(0, 8), group: purchase.group_id.slice(0, 8) } });
  await auditLog(user!.id, "group_funding_refund", "group_credit_purchase", purchase.id, {
    group_id: purchase.group_id, amount_cents: purchase.amount_cents,
  });
  return NextResponse.json({ ok: true, purchase: { id: purchase.id, status: "refunded" } });
}
