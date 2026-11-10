import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { GOODWILL_AGENT_LIMIT_CENTS, requiresAdmin } from "@/lib/helpdesk/refund-policy";
import { fmt } from "@/lib/pricing";
import { createRefund, PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ amount_cents: z.coerce.number().int().positive().max(1_000_000), reason: z.string().trim().min(5).max(300) });

/**
 * Admin-only partial refund of a captured payment. Reuses the helpdesk refund policy: the refund can never exceed the
 * remaining captured balance, and anything above the single-approver limit must go through the ticket workflow
 * (requester + a different approving admin), so this route cannot be used to bypass the second-person rule.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const isJson = req.headers.get("content-type")?.includes("json");
  const raw = isJson ? await req.json().catch(() => ({})) : Object.fromEntries(await req.formData());
  const back = (result: string, detail: string, status = 200) => {
    if (isJson) return NextResponse.json(result === "error" ? { error: detail } : { ok: true, detail }, { status: result === "error" ? status : 200 });
    const url = new URL("/admin/rentals", req.url);
    url.searchParams.set("result", result); url.searchParams.set("detail", detail);
    return NextResponse.redirect(url, 303);
  };

  if (!z.string().uuid().safeParse(id).success) return back("error", "Invalid payment.", 404);
  const p = schema.safeParse(raw);
  if (!p.success) return back("error", "Enter a whole-cent amount and a reason of at least 5 characters.", 422);
  if (!stripeConfigured()) return isJson ? NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 }) : back("error", PAYMENTS_UNCONFIGURED.error, 503);
  const db = serviceClient();
  if (!db) return isJson ? NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 }) : back("error", PAYMENTS_UNCONFIGURED.error, 503);

  const { data: pay } = await db.from("payments").select("id,state,stripe_payment_intent_id,amount_captured_cents,amount_refunded_cents,rentals(reference)").eq("id", id).maybeSingle();
  const row = pay as unknown as { id: string; state: string; stripe_payment_intent_id: string | null; amount_captured_cents: number | null; amount_refunded_cents: number | null; rentals: { reference: string } | null } | null;
  if (!row) return back("error", "Payment not found.", 404);
  if (!row.stripe_payment_intent_id || !["captured", "partially_refunded"].includes(row.state)) return back("error", "Only captured payments can be refunded.", 409);

  const captured = row.amount_captured_cents ?? 0, refunded = row.amount_refunded_cents ?? 0;
  const remaining = Math.max(0, captured - refunded);
  const { amount_cents: amount, reason } = p.data;
  if (amount > remaining) return back("error", `Only ${fmt(remaining)} remains refundable on this payment.`, 422);
  // Strictest classification (goodwill): large amounts need the two-person ticket workflow.
  if (requiresAdmin(amount, "goodwill")) return back("error", `Refunds above ${fmt(GOODWILL_AGENT_LIMIT_CENTS)} need the two-person approval flow. Open a refund request from the support ticket instead.`, 409);

  if (row.rentals?.reference) {
    const { data: open } = await db.from("refund_requests").select("id").eq("rental_ref", row.rentals.reference).in("status", ["requested", "approved"]).limit(1);
    if (open && open.length > 0) return back("error", "There is an open refund request for this rental. Resolve it in the helpdesk first.", 409);
  }

  const out = await createRefund(row.stripe_payment_intent_id, amount, `adminrefund_${row.id}_${refunded}_${amount}`, reason);
  if (!out.ok) {
    await auditLog(user.id, "admin_refund_failed", "payment", row.id, { amount, code: out.code });
    return back("error", `Stripe declined the refund (${out.code}).`, 502);
  }
  const newRefunded = refunded + amount;
  const issuedBy = /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null;
  await db.from("refunds").upsert({ payment_id: row.id, amount_cents: amount, reason, stripe_refund_id: out.data.id, issued_by: issuedBy }, { onConflict: "stripe_refund_id" });
  await db.from("payments").update({ amount_refunded_cents: newRefunded, state: newRefunded >= captured ? "refunded" : "partially_refunded" }).eq("id", row.id);
  await auditLog(user.id, "admin_refund", "payment", row.id, { amount, reason, stripe_refund_id: out.data.id });
  return back("refunded", `Refunded ${fmt(amount)}.`);
}
