import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";
import { createWalletTopupSession } from "@/lib/stripe";
import { SITE } from "@/lib/site";
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
  const checkout = await createWalletTopupSession({
    id: topup.id, profileId: c.user.id, email: c.email.endsWith("@mobile.zapnivo.com") ? undefined : c.email, amountCents: parsed.data.amount_cents,
    successUrl: `${SITE.url}/account/charging?wallet=success`, cancelUrl: `${SITE.url}/account/charging?wallet=cancelled`,
  });
  if (!checkout.ok || !checkout.data.url) {
    await c.db.from("wallet_topups").update({ status: "failed" }).eq("id", topup.id).eq("status", "pending");
    return NextResponse.json({ error: "Payment checkout is unavailable. Nothing was charged." }, { status: 503 });
  }
  const saved = await c.db.from("wallet_topups").update({ stripe_checkout_session_id: checkout.data.id }).eq("id", topup.id).eq("status", "pending");
  if (saved.error) return NextResponse.json({ error: "Could not confirm checkout setup. Nothing was charged." }, { status: 503 });
  return NextResponse.json({ checkout_url: checkout.data.url }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
