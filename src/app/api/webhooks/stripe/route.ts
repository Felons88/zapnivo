import { NextResponse } from "next/server";
import { triggerPaymentReceipt } from "@/lib/email-triggers";
import { serviceClient } from "@/lib/supabase";

/** Stripe webhook — verifies the signature (no SDK) and fires the payment_receipt email on success. */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhooks not configured" }, { status: 503 });
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return NextResponse.json({ error: "Bad signature" }, { status: 400 });

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== parts.v1) return NextResponse.json({ error: "Bad signature" }, { status: 400 });

  const event = JSON.parse(payload) as { type: string; data: { object: { id: string; amount_received?: number; receipt_email?: string } } };
  if (event.type !== "payment_intent.succeeded") return NextResponse.json({ ok: true, ignored: event.type });
  const pi = event.data.object;
  const db = serviceClient();
  if (db) {
    await db.from("payments").update({
      state: "captured",
      amount_captured_cents: pi.amount_received ?? null,
      receipt_email: pi.receipt_email ?? undefined,
      captured_at: new Date().toISOString(),
    }).eq("stripe_payment_intent_id", pi.id);
  }
  await triggerPaymentReceipt(pi.id);
  return NextResponse.json({ ok: true });
}
