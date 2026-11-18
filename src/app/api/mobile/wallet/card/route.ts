import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { cardCvc, formatPan, getOrIssueCard } from "@/lib/prepaid-card";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Explicit reveal of the full prepaid card (number, expiry, security code) to its owner only. */
export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`prepaid-reveal:${c.user.id}`, 20, 60 * 60_000).ok) return NextResponse.json({ error: "Too many reveals. Try again later." }, { status: 429 });
  const card = await getOrIssueCard(c.db, c.user.id);
  const cvc = card ? cardCvc(card) : null;
  if (!card || !cvc) return NextResponse.json({ error: "Your card is temporarily unavailable." }, { status: 503 });
  await auditLog(c.user.id, "prepaid_card_revealed", "prepaid_card", card.id);
  return NextResponse.json({ number: formatPan(card.pan), exp_month: card.exp_month, exp_year: card.exp_year, cvc, status: card.status }, { headers: { "Cache-Control": "no-store" } });
}
