import { NextResponse } from "next/server";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { walletBalance, walletHistory, walletTopupsReady } from "@/lib/wallet";
import { googleWalletPassReady } from "@/lib/google-wallet-pass";
import { getOrIssueCard, maskedPan } from "@/lib/prepaid-card";
import { publishableKey } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const [balance, transactions, card] = await Promise.all([walletBalance(c.db, c.user.id), walletHistory(c.db, c.user.id), getOrIssueCard(c.db, c.user.id)]);
  if (balance == null || transactions == null) return NextResponse.json({ error: "Wallet is temporarily unavailable." }, { status: 503 });
  const canAddFunds = walletTopupsReady();
  return NextResponse.json({
    balance_cents: balance, transactions,
    // Masked only — the full number and security code come from /wallet/card on an explicit reveal.
    card: card ? { masked: maskedPan(card.pan), last4: card.pan.slice(-4), exp_month: card.exp_month, exp_year: card.exp_year, status: card.status, network: "Zapnivo machines only" } : null,
    can_add_funds: canAddFunds, publishable_key: canAddFunds ? publishableKey() : null, can_add_to_google_wallet: googleWalletPassReady(),
  }, { headers: { "Cache-Control": "no-store" } });
}
