import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { createWalletTopupIntent, publishableKey } from "@/lib/stripe";
import { walletTopupsReady } from "@/lib/wallet";

export const dynamic = "force-dynamic";
const schema = z.object({ amount_cents: z.number().int().min(500).max(20000) });

export async function POST(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!walletTopupsReady()) return NextResponse.json({ error: "Adding funds is not available yet." }, { status: 503 });
  if (!rateLimit(`wallet-topup:${c.user.id}`, 5, 60 * 60_000).ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose an amount from $5 to $200." }, { status: 422 });

  const { data: topup, error } = await c.db.from("wallet_topups").insert({ profile_id: c.user.id, amount_cents: parsed.data.amount_cents }).select("id").single();
  if (error || !topup) return NextResponse.json({ error: "Could not start a secure checkout." }, { status: 503 });
  const intent = await createWalletTopupIntent({
    id: topup.id, profileId: c.user.id, email: c.email.endsWith("@mobile.zapnivo.com") ? undefined : c.email, amountCents: parsed.data.amount_cents,
  });
  if (!intent.ok || !intent.data.client_secret) {
    await c.db.from("wallet_topups").update({ status: "failed" }).eq("id", topup.id).eq("status", "pending");
    return NextResponse.json({ error: "In-app payment is unavailable. Nothing was charged." }, { status: 503 });
  }
  const saved = await c.db.from("wallet_topups").update({ stripe_payment_intent_id: intent.data.id }).eq("id", topup.id).eq("status", "pending");
  if (saved.error) return NextResponse.json({ error: "Could not confirm payment setup. Nothing was charged." }, { status: 503 });
  return NextResponse.json({ payment_intent_client_secret: intent.data.client_secret, publishable_key: publishableKey(), topup_id: topup.id }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
