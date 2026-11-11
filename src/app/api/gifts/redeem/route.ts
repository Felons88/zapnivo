import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { giftRedeemedConfirmation } from "@/lib/email-gifts";
import {
  GIFT_PUBLIC_SELECT, MAX_GIFT_ATTEMPTS, giftCodeHashFor, normalizeGiftCode, type GiftRow,
} from "@/lib/gifts";
import { clientIp, fail, sameOrigin } from "@/lib/helpdesk/http";
import { balance, grant } from "@/lib/monetization/entitlements";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

/**
 * POST { code } — redeem a paid gift code.
 * Grants `value_cents` of unit 'cent' entitlements to the redeemer's profile
 * (expires_at carried over). The status flip is a conditional update on
 * status='paid', so concurrent redeems of the same code can only succeed once.
 *
 * Failure responses are deliberately generic ("invalid or already redeemed") to avoid
 * leaking which codes exist; per-profile+IP rate limiting bounds brute force, and the
 * per-gift `attempts` counter locks a code after MAX_GIFT_ATTEMPTS failures.
 */

const schema = z.object({ code: z.string().trim().min(4).max(64) });
const INVALID = "That gift code is invalid or has already been redeemed.";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  if (!rateLimit(`gift-redeem:${user.id}:${clientIp(req)}`, 10, 10 * 60_000).ok) {
    return fail(429, "Too many attempts. Please try again later.");
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, INVALID);
  const normalized = normalizeGiftCode(parsed.data.code);
  if (normalized.length !== 12) return fail(422, INVALID);

  const db = serviceClient();
  if (!db) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });

  const { data: found, error: lookupErr } = await db.from("gift_credits")
    .select(GIFT_PUBLIC_SELECT).eq("code_hash", giftCodeHashFor(parsed.data.code)).maybeSingle();
  if (lookupErr) {
    recordLog("warning", "gift_redeem_lookup_failed", { service: "gifts", attrs: { err: lookupErr.message.slice(0, 160) } });
    return fail(503, "We couldn't check that code right now. Please try again.");
  }
  const gift = found as GiftRow | null;
  if (!gift) return fail(422, INVALID);

  // Failure path: count the attempt, then answer generically.
  const failAttempt = async () => {
    if ((gift.attempts ?? 0) < MAX_GIFT_ATTEMPTS) {
      await db.from("gift_credits")
        .update({ attempts: (gift.attempts ?? 0) + 1, last_attempt_at: new Date().toISOString() })
        .eq("id", gift.id);
    }
    return fail(422, INVALID);
  };

  const expired = gift.expires_at ? Date.parse(gift.expires_at) <= Date.now() : false;
  if (gift.status !== "paid" || expired || (gift.attempts ?? 0) >= MAX_GIFT_ATTEMPTS) {
    return failAttempt();
  }

  // Atomic claim: only one concurrent redeemer can flip paid → redeemed.
  const now = new Date().toISOString();
  const { data: claimed, error: claimErr } = await db.from("gift_credits")
    .update({ status: "redeemed", redeemed_by: user.id, redeemed_at: now })
    .eq("id", gift.id).eq("status", "paid")
    .select("id").maybeSingle();
  if (claimErr) {
    recordLog("warning", "gift_redeem_claim_failed", { service: "gifts", attrs: { gift: gift.id.slice(0, 8), err: claimErr.message.slice(0, 160) } });
    return fail(503, "We couldn't redeem that code right now. Please try again.");
  }
  if (!claimed) return fail(422, INVALID); // lost the race — already redeemed

  const creditCents = gift.value_cents ?? 0;
  const g = await grant(db, {
    profileId: user.id,
    kind: "gift",
    unit: "cent",
    amount: creditCents,
    expiresAt: gift.expires_at,
    sourceType: "gift_credit",
    sourceId: gift.id,
    actor: user.id,
    note: `Gift ${gift.id.slice(0, 8)}`,
  });
  if (!g.ok || creditCents <= 0) {
    // Roll the claim back so the code stays redeemable once the issue is fixed.
    await db.from("gift_credits")
      .update({ status: "paid", redeemed_by: null, redeemed_at: null })
      .eq("id", gift.id).eq("status", "redeemed").eq("redeemed_by", user.id);
    recordLog("warning", "gift_redeem_grant_failed", { service: "gifts", attrs: { gift: gift.id.slice(0, 8), err: g.ok ? "nonpositive_value" : g.error.slice(0, 120) } });
    return fail(503, "We couldn't add that credit right now. Please try again.");
  }

  const bal = await balance(db, user.id, "cent");
  void giftRedeemedConfirmation(user.email, gift.package, creditCents).catch(() => undefined);
  recordLog("info", "gift_redeemed", { service: "gifts", attrs: { gift: gift.id.slice(0, 8), cents: creditCents } });
  return NextResponse.json({ ok: true, package: gift.package, credit_cents: creditCents, balance_cents: bal?.cent ?? creditCents });
}
