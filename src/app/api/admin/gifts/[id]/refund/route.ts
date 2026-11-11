import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

/**
 * POST — staff refund of a gift credit.
 * Flips gift_credits to 'refunded' and revokes any 'cent' entitlement grant issued
 * from this gift (status → 'revoked', remaining → 0, entitlement_events 'revoke' row).
 * Accepts a form POST (redirects back to /admin/gifts) or JSON ({ ok: true }).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return NextResponse.json({ error: "Staff only." }, { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Gift not found." }, { status: 404 });

  const back = (result: string, detail?: string) => {
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    if (wantsJson) return NextResponse.json({ ok: result === "refunded", result, detail });
    const url = new URL("/admin/gifts", req.url);
    url.searchParams.set("gift", id);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail.slice(0, 120));
    return NextResponse.redirect(url, 303);
  };

  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const { data: gift, error: gErr } = await db.from("gift_credits")
    .select("id,status,value_cents,package,purchaser_email").eq("id", id).maybeSingle();
  if (gErr) return NextResponse.json({ error: "Gifts aren't available yet." }, { status: 503 });
  if (!gift) return back("error", "Gift not found.");
  if (!["paid", "redeemed"].includes(gift.status)) return back("error", `Only paid or redeemed gifts can be refunded (status: ${gift.status}).`);

  // Revoke the cent grant issued at redemption, if one is still active.
  const { data: grants } = await db.from("entitlement_grants")
    .select("id,profile_id,remaining,status").eq("source_type", "gift_credit").eq("source_id", id).eq("status", "active");
  let revoked = 0;
  for (const g of (grants ?? []) as { id: string; profile_id: string; remaining: number }[]) {
    const { error: revErr } = await db.from("entitlement_grants")
      .update({ status: "revoked", remaining: 0, updated_at: new Date().toISOString() }).eq("id", g.id).eq("status", "active");
    if (revErr) { recordLog("warning", "gift_refund_revoke_failed", { service: "gifts", attrs: { gift: id.slice(0, 8), err: revErr.message.slice(0, 120) } }); continue; }
    await db.from("entitlement_events").insert({
      grant_id: g.id, profile_id: g.profile_id, event: "revoke",
      delta: -g.remaining, balance_after: 0, ref_type: "gift", ref_id: id,
      actor: `staff:${user.id}`, note: "gift refund",
    });
    revoked += 1;
  }

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await db.from("gift_credits")
    .update({ status: "refunded", refunded_at: now, refunded_by: user.id })
    .eq("id", id).in("status", ["paid", "redeemed"]).select("id").maybeSingle();
  if (uErr || !updated) return back("error", uErr ? "The refund could not be recorded." : "The gift was already refunded.");

  await auditLog(user.id, "refund_gift", "gift_credit", id, { package: gift.package, value_cents: gift.value_cents, grants_revoked: revoked });
  recordLog("info", "gift_refunded", { service: "gifts", attrs: { gift: id.slice(0, 8), staff: user.id.slice(0, 8), revoked } });
  return back("refunded", `${gift.package} · ${revoked} grant${revoked === 1 ? "" : "s"} revoked`);
}
