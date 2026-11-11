import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { redeemPass } from "@/lib/events-program";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ code: z.string().trim().min(4).max(40) }).strict();

const ERRORS: Record<string, { msg: string; status: number }> = {
  invalid_code: { msg: "That pass code isn't valid.", status: 404 },
  unpaid: { msg: "This pass hasn't been paid yet.", status: 402 },
  revoked: { msg: "This pass was revoked.", status: 410 },
  expired: { msg: "This pass has expired.", status: 410 },
  already_redeemed: { msg: "This pass was already redeemed.", status: 409 },
  exhausted: { msg: "This pass has no rentals left.", status: 409 },
  event_missing: { msg: "This pass's event no longer exists.", status: 404 },
  event_inactive: { msg: "This event isn't active right now.", status: 409 },
  outside_window: { msg: "This event isn't running right now — try again during the event window.", status: 409 },
  redeem_failed: { msg: "Couldn't redeem the pass. Please try again.", status: 500 },
};

/** Signed-in attendee redeems an event pass code → 'rental' entitlement units. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required to redeem a pass." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!rateLimit(`events:redeem:${user.id}`, 20, 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid pass code.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const out = await redeemPass(db, user.id, parsed.data.code);
  if (!out.ok) {
    const e = ERRORS[out.error] ?? { msg: "Couldn't redeem the pass.", status: 500 };
    return NextResponse.json({ error: e.msg, code: out.error }, { status: e.status });
  }
  return NextResponse.json({ ok: true, rentals: out.rentals });
}
