import { NextResponse } from "next/server";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { googleWalletGiftPassUrl } from "@/lib/google-wallet-pass";
import { getOrIssueCard } from "@/lib/prepaid-card";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const card = await getOrIssueCard(c.db, c.user.id);
  const url = card ? googleWalletGiftPassUrl(c.user.id, card) : null;
  if (!url) return NextResponse.json({ error: "Google Wallet pass is not available yet." }, { status: 503 });
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
}
