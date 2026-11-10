import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { reportError } from "@/lib/observability";

/**
 * Partner sponsored-charging campaigns. Partners may only target kiosks inside
 * their own organization — targeting is derived server-side, never trusted.
 * New campaigns start 'pending' and require staff approval before going live.
 */

const createSchema = z.object({
  name: z.string().trim().min(3).max(120),
  credit_minutes: z.coerce.number().int().min(5).max(480),
  per_customer_minutes: z.coerce.number().int().min(5).max(120),
  per_day_minutes: z.coerce.number().int().min(5).max(480).optional(),
  budget_cents: z.coerce.number().int().min(0).max(10_000_000).optional(),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  venue_ids: z.array(z.string().uuid()).max(50).optional(),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role !== "partner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { data, error } = await db.from("sponsor_campaigns")
    .select("id,name,status,credit_minutes,per_customer_minutes,budget_cents,spent_cents,starts_at,ends_at,created_at")
    .eq("created_by", user.id).order("created_at", { ascending: false }).limit(50);
  if (error) { reportError(error, { route: "partners/sponsors" }); return NextResponse.json({ error: "Could not load campaigns" }, { status: 500 }); }
  return NextResponse.json({ campaigns: data ?? [] });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user || user.role !== "partner") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rl = rateLimit(`sponsor:${user.id}`, 5, 10 * 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Please check the campaign details.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const d = parsed.data;
  if (Date.parse(d.ends_at) <= Date.parse(d.starts_at)) return NextResponse.json({ error: "End date must be after start date." }, { status: 422 });
  if (d.per_customer_minutes > d.credit_minutes) return NextResponse.json({ error: "Per-customer minutes can't exceed the credit pool." }, { status: 422 });

  // Resolve the partner's org name + constrain targeting to their own venues/kiosks.
  const { data: org } = user.organizationId
    ? await db.from("organizations").select("name").eq("id", user.organizationId).maybeSingle()
    : { data: null };
  const orgName = (org as { name?: string } | null)?.name ?? user.email;

  let targeting: Record<string, unknown> = {};
  if (d.venue_ids?.length) {
    const { data: venues } = await db.from("venues").select("id").eq("organization_id", user.organizationId ?? "").in("id", d.venue_ids);
    const owned = ((venues ?? []) as { id: string }[]).map((v) => v.id);
    if (!owned.length) return NextResponse.json({ error: "None of those venues belong to your organization." }, { status: 422 });
    const { data: kiosks } = await db.from("kiosks").select("id").in("venue_id", owned);
    targeting = { venue_ids: owned, station_ids: ((kiosks ?? []) as { id: string }[]).map((k) => k.id) };
  }

  const { data, error } = await db.from("sponsor_campaigns").insert({
    name: d.name, sponsor_name: orgName, contact_email: user.email,
    status: "pending", credit_minutes: d.credit_minutes, per_customer_minutes: d.per_customer_minutes,
    per_day_minutes: d.per_day_minutes ?? null,
    budget_cents: d.budget_cents ?? null, targeting, starts_at: d.starts_at, ends_at: d.ends_at,
    created_by: user.id,
  }).select("id").single();
  if (error || !data) { reportError(error ?? new Error("sponsor_insert_failed"), { route: "partners/sponsors" }); return NextResponse.json({ error: "Could not create the campaign." }, { status: 500 }); }
  return NextResponse.json({ ok: true, id: (data as { id: string }).id }, { status: 201 });
}
