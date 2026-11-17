import { NextResponse } from "next/server";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { walletBalance, walletHistory, walletTopupsReady } from "@/lib/wallet";
import { googleWalletPassReady } from "@/lib/google-wallet-pass";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const [balance, transactions] = await Promise.all([walletBalance(c.db, c.user.id), walletHistory(c.db, c.user.id)]);
  if (balance == null || transactions == null) return NextResponse.json({ error: "Wallet is temporarily unavailable." }, { status: 503 });
  return NextResponse.json({ balance_cents: balance, transactions, can_add_funds: walletTopupsReady(), can_add_to_google_wallet: googleWalletPassReady() }, { headers: { "Cache-Control": "no-store" } });
}
