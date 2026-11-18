import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CATEGORIES = new Set(["account", "security", "payment", "rental", "support", "offer"]);

/**
 * GET  ?category=&unread=1&before=<iso>&limit= — paginated notification history,
 *      newest first, plus the live unread count for the badge.
 * PATCH { id: "uuid" } | { all: true } — mark read. { id, unread: true } marks
 *      unread again. Every row is scoped to the caller's profile server-side.
 */
export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-notif:${c.user.id}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const url = new URL(req.url);
  const category = url.searchParams.get("category");
  const unreadOnly = url.searchParams.get("unread") === "1";
  const before = url.searchParams.get("before");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 25));

  let q = c.db.from("notifications")
    .select("id,category,kind,title,body,data,read_at,created_at")
    .eq("profile_id", c.user.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (category && CATEGORIES.has(category)) q = q.eq("category", category);
  if (unreadOnly) q = q.is("read_at", null);
  if (before && !Number.isNaN(Date.parse(before))) q = q.lt("created_at", before);

  const [{ data }, { count }] = await Promise.all([
    q,
    c.db.from("notifications").select("id", { count: "exact", head: true }).eq("profile_id", c.user.id).is("read_at", null),
  ]);
  const rows = (data ?? []) as { id: string; category: string; kind: string; title: string; body: string; data: Record<string, string>; read_at: string | null; created_at: string }[];
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id, category: r.category, kind: r.kind, title: r.title, body: r.body,
    deepLink: typeof r.data?.deep_link === "string" ? r.data.deep_link : null,
    read: r.read_at !== null, createdAt: r.created_at,
  }));
  return NextResponse.json({
    items,
    unread: count ?? 0,
    nextBefore: rows.length > limit ? items[items.length - 1].createdAt : null,
  });
}

const patchSchema = z.object({
  id: z.string().uuid().optional(),
  all: z.literal(true).optional(),
  unread: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-notif:${c.user.id}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const p = patchSchema.safeParse(await req.json().catch(() => null));
  if (!p.success || (!p.data.id && !p.data.all)) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const readAt = p.data.unread === true ? null : new Date().toISOString();
  const q = p.data.all
    ? (p.data.unread === true
      ? c.db.from("notifications").update({ read_at: null }).eq("profile_id", c.user.id).not("read_at", "is", null)
      : c.db.from("notifications").update({ read_at: readAt }).eq("profile_id", c.user.id).is("read_at", null))
    : c.db.from("notifications").update({ read_at: readAt }).eq("profile_id", c.user.id).eq("id", p.data.id!);
  const { error } = await q;
  if (error) return NextResponse.json({ error: "Could not update." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
