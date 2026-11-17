import { NextResponse } from "next/server";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { linkedCards } from "@/lib/wallet";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const cards = await linkedCards(c.email);
  if (cards == null) return NextResponse.json({ error: "Linked cards are temporarily unavailable." }, { status: 503 });
  return NextResponse.json({ cards }, { headers: { "Cache-Control": "no-store" } });
}
