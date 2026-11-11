import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { giftRedeemedConfirmation } from "@/lib/email-gifts";
import { hashClaimToken } from "@/lib/gifts-delivery";
import { clientIp, fail, sameOrigin } from "@/lib/helpdesk/http";
import { recordLog } from "@/lib/observability";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

/**
 * POST { token } — claim a secure-delivery gift link.
 *
 * The raw token arrives only in the request body (from the emailed ?t= link); we hash
 * it immediately and never store or log the raw value. The claim_gift RPC (migration
 * 0034) atomically validates hash/expiry/status, marks the gift redeemed and grants
 * 'cent' credits in one transaction — concurrent claims can only succeed once.
 *
 * A session is required because credits land on a profile. Error mapping is honest but
 * generic enough not to aid token guessing; per-IP+token-prefix rate limiting bounds
 * brute force on top of the 192-bit token entropy.
 */

const schema = z.object({ token: z.string().trim().min(10).max(200) });

const INVALID = "That gift link is invalid or has already been used.";

type ClaimResult = { ok?: boolean; error?: string; cents?: number; expires_at?: string | null };

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in to claim this gift.");

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, INVALID);
  const tokenHash = hashClaimToken(parsed.data.token); // raw token is never stored/logged

  if (!rateLimit(`gift-claim:${clientIp(req)}:${tokenHash.slice(0, 16)}`, 10, 10 * 60_000).ok) {
    return fail(429, "Too many attempts. Please try again later.");
  }

  const db = serviceClient();
  if (!db) return fail(503, "Gifts aren't available yet.", { code: "backend_unconfigured" });

  // Resolve the gift row first (hash-only lookup) — gives us the package label for the
  // confirmation email and lets us answer invalid tokens without an RPC round-trip.
  const { data: found, error: lookupErr } = await db.from("gift_credits")
    .select("id,package,status")
    .eq("claim_token_hash", tokenHash).maybeSingle();
  if (lookupErr) {
    recordLog("warning", "gift_claim_lookup_failed", { service: "gifts", attrs: { err: lookupErr.message.slice(0, 160) } });
    return fail(503, "We couldn't check that link right now. Please try again.");
  }
  const gift = found as { id: string; package: string | null; status: string } | null;
  if (!gift) return fail(404, INVALID);

  const { data, error } = await db.rpc("claim_gift", { p_token_hash: tokenHash, p_profile: user.id });
  if (error) {
    recordLog("warning", "gift_claim_rpc_failed", { service: "gifts", attrs: { gift: gift.id.slice(0, 8), err: String((error as { message?: string }).message ?? error).slice(0, 160) } });
    return fail(503, "We couldn't claim that gift right now. Please try again.");
  }
  const result = (data ?? {}) as ClaimResult;
  if (!result.ok) {
    switch (result.error) {
      case "expired": return fail(410, "That gift link has expired. Ask the sender for a new one.");
      case "unavailable": return fail(409, "That gift has already been claimed or is no longer available.");
      case "no_value": return fail(422, "That gift has no claimable credit.");
      case "invalid_token":
      default: return fail(404, INVALID);
    }
  }

  const cents = typeof result.cents === "number" ? result.cents : 0;
  recordLog("info", "gift_claimed", { service: "gifts", attrs: { gift: gift.id.slice(0, 8), cents } });
  void giftRedeemedConfirmation(user.email, gift.package ?? "charging gift", cents).catch(() => undefined);
  return NextResponse.json({ ok: true, cents, expires_at: result.expires_at ?? null }, { headers: { "Cache-Control": "no-store" } });
}
