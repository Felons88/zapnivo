import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { GIFT_PUBLIC_SELECT, type GiftRow } from "@/lib/gifts";
import { fail } from "@/lib/helpdesk/http";
import { serviceClient } from "@/lib/supabase";

/** Purchase detail for the gift's purchaser (or the redeemer). Status timeline only — never secrets. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(404, "Gift not found.");

  const db = serviceClient();
  if (!db) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });

  const { data, error } = await db.from("gift_credits").select(GIFT_PUBLIC_SELECT).eq("id", id).maybeSingle();
  if (error) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });
  const gift = data as GiftRow | null;
  // Purchaser (profile or email match) or the person who redeemed it may view.
  const isPurchaser = gift && (gift.purchaser_profile === user.id || gift.purchaser_email.toLowerCase() === user.email.toLowerCase());
  const isRedeemer = gift?.redeemed_by === user.id;
  if (!gift || (!isPurchaser && !isRedeemer)) return fail(404, "Gift not found.");

  return NextResponse.json({
    gift: {
      id: gift.id,
      package: gift.package,
      value_cents: gift.value_cents,
      recipient_email: gift.recipient_email,
      message: gift.message,
      status: gift.status,
      created_at: gift.created_at,
      expires_at: gift.expires_at,
      redeemed_at: gift.redeemed_at,
      refunded_at: gift.refunded_at,
    },
    timeline: [
      { event: "created", at: gift.created_at },
      // gift_credits has no paid_at column; status 'paid' is implied between created and redeemed/refunded.
      gift.redeemed_at ? { event: "redeemed", at: gift.redeemed_at } : null,
      gift.refunded_at ? { event: "refunded", at: gift.refunded_at } : null,
    ].filter(Boolean),
  }, { headers: { "Cache-Control": "no-store" } });
}
