import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { createGroupFundingCheckout } from "@/lib/monetization/checkout";
import { rateLimit } from "@/lib/rate-limit";
import { subUrl } from "@/lib/site";
import { PAYMENTS_UNCONFIGURED, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

/** Self-serve group pool funding bounds (integer cents). */
export const GROUP_FUNDING_MIN_CENTS = 500;   // $5
export const GROUP_FUNDING_MAX_CENTS = 50_000; // $500

const postSchema = z.object({
  amountCents: z.number().int().min(GROUP_FUNDING_MIN_CENTS).max(GROUP_FUNDING_MAX_CENTS),
}).strict();

type GroupRow = { id: string; organizer_id: string; name: string; status: string };
type PurchaseRow = {
  id: string; amount_cents: number; status: string;
  created_at: string; paid_at: string | null;
};

const PURCHASE_SELECT = "id,amount_cents,status,created_at,paid_at";

/** Organizer-only group lookup — non-organizers get a plain 404 (no existence leak). */
async function ownedGroup(db: NonNullable<ReturnType<typeof serviceClient>>, userId: string, groupId: string) {
  const { data } = await db.from("rental_groups")
    .select("id,organizer_id,name,status").eq("id", groupId).maybeSingle();
  const g = data as GroupRow | null;
  if (!g || g.organizer_id !== userId) return null;
  return g;
}

/**
 * GET /api/groups/[id]/fund — the organizer's funding history for the group.
 * RLS already scopes group_credit_purchases to organizer/staff; we still verify
 * ownership server-side so members get the same 404 as strangers.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const group = await ownedGroup(db, user.id, id);
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });
  const { data, error } = await db.from("group_credit_purchases").select(PURCHASE_SELECT)
    .eq("group_id", id).eq("organizer_id", user.id)
    .order("created_at", { ascending: false }).limit(50);
  if (error) {
    recordLog("warning", "group_funding_history_failed", { service: "groups", route: "api/groups/[id]/fund", attrs: { err: error.message.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't load funding history." }, { status: 503 });
  }
  return NextResponse.json({ purchases: (data ?? []) as PurchaseRow[] });
}

/**
 * POST /api/groups/[id]/fund { amountCents }
 * Organizer funds the shared credit pool via Stripe Checkout. The
 * group_credit_purchases row is created 'pending' BEFORE the Stripe call so the
 * webhook can fulfill it by purchase_id — organizers can never write
 * credit_cents directly; only the fund_group_credit RPC (webhook) does that.
 * 503 when Stripe isn't configured.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!stripeConfigured()) return NextResponse.json(PAYMENTS_UNCONFIGURED, { status: 503 });

  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 422 }); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error: `Amount must be a whole number of cents between $${(GROUP_FUNDING_MIN_CENTS / 100).toFixed(0)} and $${(GROUP_FUNDING_MAX_CENTS / 100).toFixed(0)}.`,
    }, { status: 422 });
  }

  const rl = rateLimit(`group-fund:${user.id}`, 10, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const group = await ownedGroup(db, user.id, id);
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });
  if (group.status !== "active") return NextResponse.json({ error: "This group is closed." }, { status: 409 });

  // Purchase row FIRST — the webhook flips it pending → paid and tops up the pool.
  const { data: purchase, error: insErr } = await db.from("group_credit_purchases")
    .insert({ group_id: group.id, organizer_id: user.id, amount_cents: parsed.data.amountCents, status: "pending" })
    .select("id").single();
  if (insErr || !purchase) {
    recordLog("error", "group_funding_insert_failed", { service: "groups", route: "api/groups/[id]/fund", attrs: { group: group.id.slice(0, 8), err: insErr?.message?.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't start the payment. Please try again." }, { status: 503 });
  }
  const purchaseId = (purchase as { id: string }).id;

  const back = subUrl("customer", `/groups/${group.id}`);
  const session = await createGroupFundingCheckout({
    purchaseId, groupId: group.id, groupName: group.name, amountCents: parsed.data.amountCents,
    email: user.email,
    successUrl: `${back}?funded=1`, cancelUrl: `${back}?funded=0`,
  });
  if (!session.ok || !session.data.url) {
    // Leave the row 'pending' — an honest state a later paid webhook can still fulfill.
    recordLog("error", "group_funding_checkout_failed", { service: "groups", route: "api/groups/[id]/fund", attrs: { purchase: purchaseId, reason: session.ok ? "no_url" : session.code } });
    return NextResponse.json({ error: "Payment couldn't be started. Please try again." }, { status: 502 });
  }

  await db.from("group_credit_purchases").update({ stripe_checkout_session_id: session.data.id }).eq("id", purchaseId);
  recordLog("info", "group_funding_checkout_started", { service: "groups", route: "api/groups/[id]/fund", attrs: { purchase: purchaseId, group: group.id.slice(0, 8) } });

  return NextResponse.json({ ok: true, url: session.data.url });
}
